// cloudflare-admin-toolkit — 명령 하나로 설치 · 업데이트
//
//   node setup.mjs --init       setup.env 만들기 (빈 칸 샘플 = public/setup.example.env)
//   node setup.mjs --dry-run    값 · 토큰 · 로그인 확인과 빌드 검사만 (아무것도 만들지 않음)
//   node setup.mjs              setup.env 대로 KV 만들기 → 배포(시크릿 함께)
//
// - 소스 폴더의 wrangler.jsonc 는 건드리지 않는다.
//   설치용 설정은 wrangler.setup.jsonc 에 따로 만들고 --config 로 배포한다.
// - 계정 ID 를 적어 둔 wrangler.jsonc 의 Worker 이름이나, 이 스크립트가 만들지 않은 기존 Worker 이름이면 멈춘다.
// - setup.env 의 시크릿은 올린 뒤 파일에서 지운다. 다시 실행할 때 비워 두면 이미 올린 값을 쓴다.
// - 의존성 0. Node 18 이상 + npx(wrangler).

import { readFileSync, writeFileSync, existsSync, unlinkSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { validateField } from './src/settings.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const fileArg = argv.find((a) => a.startsWith('--file='));
const ENV_FILE = resolve(ROOT, fileArg ? fileArg.slice(7) : 'setup.env');
const SAMPLE = join(ROOT, 'public', 'setup.example.env');
const CONFIG = join(ROOT, 'wrangler.setup.jsonc');
const STATE = join(ROOT, '.setup-state.json');
const MAIN_CONFIG = join(ROOT, 'wrangler.jsonc');
const DRY = has('--dry-run');
const SECRET_KEYS = ['CF_API_TOKEN', 'CF_IP_TOKEN', 'PASSWORD_PREFIX'];
const KNOWN = ['WORKER_NAME', 'ACCOUNT_ID', 'CUSTOM_DOMAIN', ...SECRET_KEYS, 'SERVER_IP', 'DEFAULT_GROUP', 'IP_PAIR_ZONE_NAME',
  'OTP_ISSUER', 'CACHE_TTL_MINUTES', 'IP_RATE_BUDGET', 'CONCURRENCY', 'MAX_ZONES_PER_CALL', 'IP_ACCOUNT_ID'];

const say = (s = '') => console.log(s);
const step = (s) => console.log('\n▶ ' + s);
// 멈출 땐 던져서 맨 아래에서 처리한다 (Windows 에서 fetch 직후 process.exit 하면 Node 가 assert 로 죽음)
class Stop extends Error {}
function fail(msg) { throw new Stop(msg); }
function done() { throw new Stop(''); }

try {
if (has('--help') || has('-h')) {
  say(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  done();
}
if (typeof fetch !== 'function') fail('Node.js 18 이상이 필요합니다.');

// ── --init: 빈 칸 샘플을 setup.env 로 ─────────────────────────
if (has('--init')) {
  if (existsSync(ENV_FILE)) fail(ENV_FILE + ' 이(가) 이미 있습니다. 그 파일을 고쳐서 쓰세요.');
  copyFileSync(SAMPLE, ENV_FILE);
  say('만들었습니다: ' + ENV_FILE);
  say('빈 칸을 채운 뒤  node setup.mjs');
  done();
}

// ── setup.env 읽기 ────────────────────────────────────────────
if (!existsSync(ENV_FILE)) fail(ENV_FILE + ' 이(가) 없습니다. 먼저  node setup.mjs --init  으로 만들고 빈 칸을 채우세요.');
const envText = readFileSync(ENV_FILE, 'utf8').replace(/^﻿/, '');
const E = {};
const errors = [];
envText.split(/\r?\n/).forEach((line, i) => {
  const t = line.trim();
  if (!t || t.startsWith('#')) return;
  const m = /^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(t);
  if (!m) { errors.push((i + 1) + '번째 줄: KEY=값 형식이 아닙니다'); return; }
  let v = m[2].trim();
  if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
  if (!KNOWN.includes(m[1])) { errors.push((i + 1) + '번째 줄: 모르는 이름 ' + m[1]); return; }
  E[m[1]] = v;
});
const val = (k) => (E[k] || '').trim();

// ── 값 검사 ───────────────────────────────────────────────────
const mainText = existsSync(MAIN_CONFIG) ? readFileSync(MAIN_CONFIG, 'utf8') : '';
// 이 폴더의 wrangler.jsonc 로 운영 중인 Worker 이름 — 덮어쓰지 않게 막는다 (계정 ID 를 적어 둔 경우만, 템플릿 그대로면 제외)
const mainLive = mainText.replace(/^\s*\/\/.*$/gm, '');
const mainName = /"account_id"\s*:\s*"[0-9a-f]{32}"/.test(mainLive) ? ((/"name"\s*:\s*"([^"]+)"/.exec(mainLive) || [])[1] || '') : '';
const compat = (/"compatibility_date"\s*:\s*"([^"]+)"/.exec(mainText) || [])[1] || '2026-09-01';

// src/settings.js 의 검사를 그대로 쓰고, 오류 문구 앞의 항목 이름만 setup.env 이름으로 바꾼다
function check(key, field, raw) {
  try { return validateField(field, raw); } catch (e) { errors.push(key + ': ' + e.message.replace(/^[^:]+:\s*/, '')); return null; }
}
function checkInt(key, raw, min, max) {
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) { errors.push(key + ': ' + min + '~' + max + ' 사이의 정수'); return null; }
  return String(Number(raw));
}

const name = val('WORKER_NAME');
if (!name) errors.push('WORKER_NAME: 비어 있습니다');
else if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) errors.push('WORKER_NAME: 영문 소문자 · 숫자 · - 만 (앞뒤는 - 불가, 63자 이하)');
else if (mainName && name === mainName) errors.push('WORKER_NAME: ' + name + ' 은(는) 이 폴더의 wrangler.jsonc 가 쓰는(운영 중인) Worker 이름입니다. 다른 이름을 쓰세요');
if (val('ACCOUNT_ID') && !/^[0-9a-f]{32}$/.test(val('ACCOUNT_ID'))) errors.push('ACCOUNT_ID: 32자리 계정 ID (영문 소문자 · 숫자)');
if (val('IP_ACCOUNT_ID') && !/^[0-9a-f]{32}$/.test(val('IP_ACCOUNT_ID'))) errors.push('IP_ACCOUNT_ID: 32자리 계정 ID');
const domain = val('CUSTOM_DOMAIN') ? check('CUSTOM_DOMAIN', 'ipPairZoneName', val('CUSTOM_DOMAIN')) : '';
if (val('PASSWORD_PREFIX') && /\s/.test(val('PASSWORD_PREFIX'))) errors.push('PASSWORD_PREFIX: 공백은 쓸 수 없습니다');

const vars = {};
if (!val('SERVER_IP')) errors.push('SERVER_IP: 비어 있습니다');
else vars.SERVER_IP = check('SERVER_IP', 'serverIp', val('SERVER_IP'));
vars.DEFAULT_GROUP = val('DEFAULT_GROUP');
if (vars.DEFAULT_GROUP.length > 40) errors.push('DEFAULT_GROUP: 40자 이하');
vars.CONCURRENCY = val('CONCURRENCY') ? checkInt('CONCURRENCY', val('CONCURRENCY'), 1, 20) : '6';
vars.CACHE_TTL_MINUTES = val('CACHE_TTL_MINUTES') ? String(check('CACHE_TTL_MINUTES', 'cacheTtlMinutes', val('CACHE_TTL_MINUTES'))) : '10';
vars.MAX_ZONES_PER_CALL = val('MAX_ZONES_PER_CALL') ? checkInt('MAX_ZONES_PER_CALL', val('MAX_ZONES_PER_CALL'), 1, 10) : '5';
vars.OTP_ISSUER = val('OTP_ISSUER') ? check('OTP_ISSUER', 'otpIssuer', val('OTP_ISSUER')) : 'CF Admin';
vars.IP_PAIR_ZONE_NAME = val('IP_PAIR_ZONE_NAME') ? check('IP_PAIR_ZONE_NAME', 'ipPairZoneName', val('IP_PAIR_ZONE_NAME')) : '';
vars.IP_RATE_BUDGET = val('IP_RATE_BUDGET') ? String(check('IP_RATE_BUDGET', 'ipRateBudget', val('IP_RATE_BUDGET'))) : '900';
if (val('IP_ACCOUNT_ID')) vars.IP_ACCOUNT_ID = val('IP_ACCOUNT_ID');

// 이 스크립트로 이미 설치한 적이 있는지 (계정/이름별)
let state = { installs: {} };
try { state = JSON.parse(readFileSync(STATE, 'utf8')); } catch { /* 처음 */ }
if (!state.installs) state.installs = {};

if (errors.length) fail('setup.env 를 고쳐 주세요:\n  - ' + errors.join('\n  - '));

// ── wrangler 실행 ─────────────────────────────────────────────
const q = (s) => (/[\s"&|<>^()%!]/.test(s) ? '"' + String(s).replace(/"/g, '\\"') + '"' : s);
// 결과를 모으면서(echo 면 화면에도) 보여 준다. 로그인만 입력을 받는다
function wrangler(args, { echo = true, interactive = false, env = {} } = {}) {
  return new Promise((done) => {
    const p = spawn(['npx', '--yes', 'wrangler', ...args].map(q).join(' '), {
      cwd: ROOT, shell: true, env: { ...process.env, ...env },
      stdio: [interactive ? 'inherit' : 'ignore', interactive ? 'inherit' : 'pipe', interactive ? 'inherit' : 'pipe'],
    });
    let out = '';
    const take = (d) => { out += d; if (echo) process.stdout.write(d); };
    if (!interactive) { p.stdout.on('data', take); p.stderr.on('data', take); }
    p.on('close', (code) => done({ code, out: out.replace(/\x1b\[[0-9;]*m/g, '') }));
  });
}

// Cloudflare API (토큰 확인용, 읽기만)
async function cf(token, path) {
  try {
    const r = await fetch('https://api.cloudflare.com/client/v4' + path, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.success, j, msg: ((j.errors || [])[0] || {}).message || ('HTTP ' + r.status), code: ((j.errors || [])[0] || {}).code };
  } catch (e) {
    return { ok: false, j: {}, msg: e.message };
  }
}

function writeConfig(accountId, kvId) {
  const cfg = {
    name,
    account_id: accountId,
    main: 'src/worker.js',
    compatibility_date: compat,
    workers_dev: true,
    assets: { directory: './public', binding: 'ASSETS', run_worker_first: true },
  };
  if (kvId) cfg.kv_namespaces = [{ binding: 'BDM_KV', id: kvId }];
  if (domain) cfg.routes = [{ pattern: domain, custom_domain: true }];
  cfg.vars = vars;
  writeFileSync(CONFIG, '// setup.mjs 가 만든 파일 — 직접 고치지 말고 setup.env 를 고친 뒤 node setup.mjs\n' + JSON.stringify(cfg, null, 2) + '\n');
}

// ── 1. 토큰 확인 ──────────────────────────────────────────────
if (!has('--skip-token-check')) {
  const apiToken = val('CF_API_TOKEN');
  if (apiToken) {
    step('토큰 확인');
    const z = await cf(apiToken, '/zones?per_page=1');
    if (!z.ok) fail('CF_API_TOKEN 으로 도메인 목록을 못 읽었습니다: ' + z.msg + ' (값 · Zone Read 권한 확인)');
    const total = (z.j.result_info || {}).total_count || 0;
    say('  CF_API_TOKEN: 도메인 ' + total + '개 보임');
    if (!total) say('  ⚠ 보이는 도메인이 없습니다. 토큰의 Zone Resources 를 확인하세요');
    const ipToken = val('CF_IP_TOKEN') || apiToken;
    let acct = val('IP_ACCOUNT_ID') || ((z.j.result || [])[0] || { account: {} }).account.id;
    if (vars.IP_PAIR_ZONE_NAME) {
      const p = await cf(ipToken, '/zones?per_page=1&name=' + encodeURIComponent(vars.IP_PAIR_ZONE_NAME));
      if (!p.ok || !(p.j.result || []).length) fail('IP_PAIR_ZONE_NAME ' + vars.IP_PAIR_ZONE_NAME + ' 을(를) 토큰으로 찾을 수 없습니다 (이름 · 권한 확인, 쓰지 않으면 비워 두세요)');
      acct = val('IP_ACCOUNT_ID') || p.j.result[0].account.id;
    }
    if (acct) {
      const a = await cf(ipToken, '/accounts/' + acct + '/firewall/access_rules/rules?per_page=1');
      say(a.ok ? '  IP Rules 토큰: 계정 IP 룰 읽기 가능' : '  ⚠ IP Rules 토큰으로 계정 IP 룰을 못 읽었습니다 (' + a.msg + ') — IP Rules 메뉴만 안 되고 나머지는 됩니다');
    }
  }
}

// ── 2. wrangler 로그인 · 계정 ─────────────────────────────────
step('wrangler 로그인 확인');
let who = await wrangler(['whoami'], { echo: false });
if (who.code !== 0 || /not authenticated|You are not logged in/i.test(who.out)) {
  say('  로그인이 필요합니다 — 브라우저가 열리면 Worker 를 둘 계정으로 허용하세요');
  const l = await wrangler(['login'], { interactive: true });
  if (l.code !== 0) fail('wrangler 로그인에 실패했습니다.');
  who = await wrangler(['whoami'], { echo: false });
}
const accounts = [];
for (const m of who.out.matchAll(/([^│|\n]+?)\s*[│|]\s*([0-9a-f]{32})/g)) {
  if (!accounts.some((a) => a.id === m[2])) accounts.push({ name: m[1].replace(/^[\s│|]+/, '').trim(), id: m[2] });
}
let accountId = val('ACCOUNT_ID');
if (accountId) {
  if (accounts.length && !accounts.some((a) => a.id === accountId)) fail('ACCOUNT_ID 가 로그인한 계정 목록에 없습니다:\n' + accounts.map((a) => '  ' + a.id + '  ' + a.name).join('\n'));
} else if (accounts.length === 1) {
  accountId = accounts[0].id;
} else {
  fail('계정이 ' + (accounts.length ? '여러 개' : '보이지 않습니다') + '입니다. setup.env 의 ACCOUNT_ID 에 Worker 를 둘 계정 ID 를 적으세요:\n' + accounts.map((a) => '  ' + a.id + '  ' + a.name).join('\n'));
}
const acctName = (accounts.find((a) => a.id === accountId) || {}).name || '';
say('  계정: ' + acctName + ' (' + accountId.slice(0, 4) + '…' + accountId.slice(-4) + ')');

const key = accountId + '/' + name;
const inst = state.installs[key] || {};
const firstRun = !inst.deployed;

// ── 3. 같은 이름의 Worker 가 이미 있는지 ───────────────────────
writeConfig(accountId, inst.kvId);
if (firstRun) {
  step('같은 이름의 Worker 가 있는지 확인');
  const d = await wrangler(['deployments', 'list', '--config', CONFIG], { echo: false });
  if (d.code === 0) {
    if (!has('--force')) fail('이 계정에 이미 ' + name + ' Worker 가 있습니다. 덮어쓰지 않도록 멈췄습니다.\n  다른 WORKER_NAME 을 쓰세요. (이 도구를 설치한 Worker 가 맞고 업데이트하려는 거면 --force)');
    say('  있음 — --force 라서 그 Worker 에 덮어씁니다');
  } else if (/10007|does not exist|not found/i.test(d.out)) {
    say('  없음 — 새로 만듭니다');
  } else {
    // 없다는 답이 아니면(네트워크 등) 확인하지 못한 것 — 덮어쓸 위험이 있으니 멈춘다
    fail('같은 이름의 Worker 가 있는지 확인하지 못했습니다:\n' + d.out.trim().split('\n').slice(-5).join('\n'));
  }
}
const missing = [];
if (!val('CF_API_TOKEN') && !(inst.secrets || []).includes('CF_API_TOKEN')) missing.push('CF_API_TOKEN');
if (!val('PASSWORD_PREFIX') && !(inst.secrets || []).includes('PASSWORD_PREFIX')) missing.push('PASSWORD_PREFIX');
if (missing.length) fail('처음 설치에는 ' + missing.join(' · ') + ' 이(가) 필요합니다.');

// ── dry-run: 여기까지 확인하고 빌드만 검사 ──────────────────────
if (DRY) {
  step('빌드 검사 (올리지 않음)');
  const r = await wrangler(['deploy', '--dry-run', '--config', CONFIG]);
  if (r.code !== 0) fail('빌드 검사에 실패했습니다.');
  say('\n✔ 확인 완료 — 아무것도 만들지 않았습니다. 실제 설치:  node setup.mjs');
  say('  하게 될 일: ' + (inst.kvId ? 'KV 그대로 사용' : 'KV 새로 만들기') + ' → 배포(' + name + ')' +
    (domain ? ' → 도메인 ' + domain : '') + ' → 시크릿 ' + [...SECRET_KEYS.filter((k) => val(k)), ...(inst.sessionSecret ? [] : ['SESSION_SECRET(자동)'])].join(' · '));
  done();
}

// ── 4. KV ─────────────────────────────────────────────────────
let kvId = inst.kvId;
if (!kvId) {
  step('KV 만들기');
  const title = name + '-kv';
  const c = await wrangler(['kv', 'namespace', 'create', title, '--config', CONFIG]);
  kvId = (/"?id"?\s*[:=]\s*"([0-9a-f]{32})"/.exec(c.out) || [])[1];
  if (!kvId) {
    // 이미 있으면(예전 설치 기록을 잃은 경우) 목록에서 찾는다
    const l = await wrangler(['kv', 'namespace', 'list', '--config', CONFIG], { echo: false });
    try {
      const found = JSON.parse(l.out.slice(l.out.indexOf('['))).find((n) => n.title === title || n.title.endsWith('-' + title));
      if (found) kvId = found.id;
    } catch { /* 아래에서 실패 처리 */ }
  }
  if (!kvId) fail('KV 를 만들지 못했습니다. 위 메시지를 확인하세요.');
  inst.kvId = kvId;
  state.installs[key] = inst;
  writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
  writeConfig(accountId, kvId);
}

// ── 5. 배포 + 시크릿 ──────────────────────────────────────────
const secrets = {};
for (const k of SECRET_KEYS) if (val(k)) secrets[k] = val(k);
if (!inst.sessionSecret) secrets.SESSION_SECRET = randomBytes(32).toString('hex');
step('배포' + (Object.keys(secrets).length ? ' (시크릿 ' + Object.keys(secrets).join(' · ') + ' 함께)' : ''));
const secretFile = join(tmpdir(), 'cfat-secrets-' + randomBytes(6).toString('hex') + '.json');
let dep;
try {
  const args = ['deploy', '--config', CONFIG];
  if (Object.keys(secrets).length) {
    writeFileSync(secretFile, JSON.stringify(secrets), { mode: 0o600 });
    args.push('--secrets-file', secretFile);
  }
  dep = await wrangler(args);
} finally {
  try { unlinkSync(secretFile); } catch { /* 없음 */ }
}
if (dep.code !== 0) fail('배포에 실패했습니다. 위 메시지를 확인하세요.');

inst.deployed = true;
if (secrets.SESSION_SECRET) inst.sessionSecret = true;
inst.secrets = [...new Set([...(inst.secrets || []), ...Object.keys(secrets).filter((k) => k !== 'SESSION_SECRET')])];
inst.at = new Date().toISOString();
state.installs[key] = inst;
writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');

// 올린 시크릿은 setup.env 에서 지운다
const cleared = SECRET_KEYS.filter((k) => val(k));
if (cleared.length) {
  const re = new RegExp('^([ \\t]*(?:' + cleared.join('|') + ')[ \\t]*=)[^\\r\\n]*', 'gm');
  writeFileSync(ENV_FILE, readFileSync(ENV_FILE, 'utf8').replace(re, '$1'));
}

// ── 결과 ──────────────────────────────────────────────────────
const url = (/https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(dep.out) || [])[0] || '';
const dd = String(new Date(Date.now() + 9 * 3600e3).getUTCDate()).padStart(2, '0');
say('\n✔ ' + (firstRun ? '설치' : '업데이트') + ' 완료');
if (url) say('  주소     ' + url);
if (domain) say('  도메인   https://' + domain + '  (처음엔 연결까지 몇 분 걸릴 수 있음)');
say('  로그인   비밀번호 = PASSWORD_PREFIX 값 + ! + 오늘 날짜 두 자리  (오늘은 …!' + dd + ')');
if (firstRun) say('  다음     로그인 → 위쪽 "2단계 인증" 으로 OTP 등록 (처음 등록한 사람이 관리자. 등록 전엔 비밀번호만 알면 누구나 설정 변경 가능)');
if (cleared.length) say('  setup.env 에서 ' + cleared.join(' · ') + ' 값을 지웠습니다. 다음에 실행할 때 비워 두면 그대로 유지됩니다.');
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  if (e.message) { console.error('\n✖ ' + e.message); process.exitCode = 1; }
}
