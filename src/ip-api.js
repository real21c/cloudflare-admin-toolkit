// IP 룰 관리 — Cloudflare IP Access Rules
//
// 404 가드가 IP 하나당 두 개를 쌍으로 만든다.
//   계정 룰   : Interactive Challenge   notes = "추가시간 | URL | User-Agent"
//   자산존 룰 : 자산존 Allow            notes = "404 guard: asset zone exemption"
// 이 모듈은 그 룰을 보고 · 지우고 · Action 을 바꾸는 관리 화면용 API 다. (404 감지·등록은 이 도구 밖의 404 가드가 한다)
//
// cf-ip-rules-manager(로컬 전용 도구)를 옮긴 것. 달라진 점:
//   - Workers 는 요청마다 따로 실행되고 외부 호출이 요청당 50개로 제한된다.
//     → 목록은 브라우저가 1000건씩 페이지로 받고, 일괄 작업은 호출 40개 이하로 묶어서 보낸다.
//     → 서버 메모리 캐시가 없으므로 자산존 Allow 룰(mates)은 브라우저가 존 목록에서 찾아 같이 보낸다.
//   - 5분 900회 속도 조절도 브라우저가 한다. 서버는 응답마다 이번에 쓴 호출 수(calls)를 알려 주고,
//     Cloudflare 가 429 를 주면 거기서 멈추고 rateLimited + retryAfter 를 돌려준다.
//   - 분류 규칙(filters)은 저장소 ip:filters 에 둔다 (Workers = KV, 로컬 = data/).
//   - 계정 ID · 자산존 ID 는 토큰으로 자동으로 찾는다 (설정으로 줄 수도 있다).
//
// 필요한 토큰 권한: Account > Account Firewall Access Rules > Edit
//                  Zone > Firewall Services > Edit  (자산존 Allow 룰)
//                  Zone > Zone > Read               (계정·존 ID 찾기 — 도메인 도구 토큰에 이미 있음)

import { DEFAULT_FILTERS } from './ip-filters-default.js';
import { nowStamp } from './core.js';

const CF = 'https://api.cloudflare.com/client/v4';
export const MODES = ['block', 'challenge', 'managed_challenge', 'js_challenge', 'whitelist'];
const MODE_LABEL = { block: 'Block', challenge: 'Interactive Challenge', managed_challenge: 'Managed Challenge', js_challenge: 'JS Challenge', whitelist: 'Allow' };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TARGETS = ['ip', 'ip6', 'ip_range', 'asn', 'country'];
const PER_PAGE = 1000;
export const MAX_CALLS = 40; // 한 요청에서 쓸 수 있는 Cloudflare 호출 수 (Workers 50개 제한 아래로)
const CATS = ['attack', 'gray', 'clean'];

class BadRequest extends Error {}
class Conflict extends Error {}
const IDS_TTL = 24 * 60 * 60 * 1000; // 자동으로 찾은 계정·존 ID 는 하루 동안 기억

class RateLimited extends Error {
  constructor(retryAfter) { super('Cloudflare API 한도(5분 1,200회)에 걸렸습니다'); this.retryAfter = retryAfter; }
}

// ── 분류 규칙 검증 (cf-ip-rules-manager 와 같음) ─────────────────
export function validateFilters(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('규칙 형식이 잘못되었습니다.');
  const labels = {};
  for (const c of CATS) {
    const v = cfg.labels && typeof cfg.labels[c] === 'string' ? cfg.labels[c].trim() : '';
    if (!v || v.length > 20) throw new Error(`분류 이름(${c})은 1~20자여야 합니다.`);
    labels[c] = v;
  }
  if (!Array.isArray(cfg.rules) || cfg.rules.length > 2000) throw new Error('규칙 목록이 잘못되었습니다.');
  const seen = new Set();
  const rules = cfg.rules.map((r, i) => {
    if (!r || typeof r !== 'object') throw new Error(`규칙 #${i + 1} 형식 오류`);
    const pattern = typeof r.pattern === 'string' ? r.pattern.trim() : '';
    if (!pattern || pattern.length > 2000) throw new Error(`규칙 #${i + 1}: 패턴은 1~2000자여야 합니다.`);
    if (!CATS.includes(r.cat)) throw new Error(`규칙 #${i + 1}: 분류 값 오류`);
    if (!['url', 'ua'].includes(r.field)) throw new Error(`규칙 #${i + 1}: 대상 값 오류`);
    if (!['text', 'regex'].includes(r.type)) throw new Error(`규칙 #${i + 1}: 방식 값 오류`);
    if (r.type === 'regex') {
      try { new RegExp(pattern, 'i'); } catch (e) { throw new Error(`정규식 오류 (${pattern}): ${e.message}`); }
    }
    let id = typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(r.id) ? r.id : '';
    if (!id || seen.has(id)) id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    seen.add(id);
    const note = typeof r.note === 'string' ? r.note.trim().slice(0, 200) : '';
    return { id, cat: r.cat, field: r.field, type: r.type, pattern, note };
  });
  return { labels, rules };
}

// notes 형식: "추가시간 | URL | User-Agent"
function parseNotes(notes) {
  const s = (notes || '').trim();
  const i1 = s.indexOf('|');
  if (i1 < 0) return { time: '', url: '', ua: s };
  const i2 = s.indexOf('|', i1 + 1);
  if (i2 < 0) return { time: s.slice(0, i1).trim(), url: s.slice(i1 + 1).trim(), ua: '' };
  return { time: s.slice(0, i1).trim(), url: s.slice(i1 + 1, i2).trim(), ua: s.slice(i2 + 1).trim() };
}

function normalize(r) {
  const cfg = r.configuration || {};
  const p = parseNotes(r.notes);
  return {
    id: r.id, target: cfg.target || '', value: cfg.value || '', mode: r.mode, notes: r.notes || '',
    time: p.time, url: p.url, ua: p.ua,
    created_on: r.created_on || '', modified_on: r.modified_on || '',
    scope: (r.scope && r.scope.type) || '', scopeName: (r.scope && r.scope.name) || '',
    configuration: cfg,
  };
}

const isNotFound = (e) => !!e && (e.status === 404 || (e.codes || []).includes(10001) || /not found/i.test(e.message || ''));

export function createIpApi({ store, config, log }) {
  const token = config.ipToken || '';
  let calls = 0; // 이번 요청에서 쓴 Cloudflare 호출 수 — 브라우저 속도 조절용

  async function cf(method, path, body) {
    calls++;
    let res;
    try {
      res = await fetch(CF + path, {
        method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error('Cloudflare 연결 실패: ' + e.message);
    }
    if (res.status === 429) throw new RateLimited(Number(res.headers.get('retry-after')) || 30);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      const errors = json.errors || [];
      const err = new Error(errors.map((e) => e.code + ': ' + e.message).join('; ') || 'HTTP ' + res.status);
      err.status = res.status;
      err.codes = errors.map((e) => e.code);
      throw err;
    }
    return json;
  }

  // 계정 ID · 자산존 ID — 설정에 없으면 토큰으로 찾아서 하루 동안 기억한다.
  // 기억해 둔 값은 설정(존 이름·직접 준 ID)이 같을 때만 쓰고, 잘못된 존 오류가 나면 지운다 (dropIdsIfStale)
  const want = config.ipPairZoneName || '';
  const idsKey = [want, config.ipAccountId || '', config.ipPairZoneId || ''].join('|');
  async function ids() {
    if (config.ipAccountId && (config.ipPairZoneId || !want)) {
      return { accountId: config.ipAccountId, zoneId: config.ipPairZoneId || '', zoneName: want };
    }
    const cached = await store.get('ip:ids', null);
    if (cached && cached.key === idsKey && Date.now() - (cached.at || 0) < IDS_TTL && cached.accountId && (cached.zoneId || !want)) {
      return { accountId: cached.accountId, zoneId: cached.zoneId, zoneName: want };
    }
    let accountId = config.ipAccountId || '';
    let zoneId = config.ipPairZoneId || '';
    if (want && !zoneId) {
      const j = await cf('GET', '/zones?name=' + encodeURIComponent(want) + '&per_page=1');
      const z = (j.result || [])[0];
      if (!z) throw new Error('자산존 ' + want + ' 을(를) 찾을 수 없습니다 (토큰 권한 또는 이름 확인)');
      zoneId = z.id;
      if (!accountId && z.account) accountId = z.account.id;
    }
    if (!accountId) {
      const j = await cf('GET', '/zones?per_page=1');
      const z = (j.result || [])[0];
      if (!z || !z.account) throw new Error('계정 ID 를 찾을 수 없습니다 (토큰에 Zone Read 권한 필요)');
      accountId = z.account.id;
    }
    await store.put('ip:ids', { key: idsKey, accountId, zoneId, zoneName: want, at: Date.now() });
    return { accountId, zoneId, zoneName: want };
  }
  // 존·계정이 없다는 오류면 기억한 ID 가 낡은 것 — 다음 요청에서 다시 찾게 지운다
  async function dropIdsIfStale(e) {
    if (e && (e.status === 404 || (e.codes || []).some((c) => c === 7003 || c === 7000 || c === 1001))) {
      try { await store.put('ip:ids', null); } catch { /* 무시 */ }
    }
  }
  // 자산존을 쓰도록 설정됐는지 — 설정됐으면 계정 룰 삭제에 자산존 Allow 목록(mates)이 반드시 있어야 한다
  const pairing = !!(want || config.ipPairZoneId);

  function base(scope, id) {
    return scope === 'zone'
      ? '/zones/' + id.zoneId + '/firewall/access_rules/rules'
      : '/accounts/' + id.accountId + '/firewall/access_rules/rules';
  }

  // CF 에서 이미 지워진 규칙이면 성공으로 본다 (404 가드가 챌린지 통과자를 수시로 지우므로 흔하다)
  async function cfDelete(scope, id, ruleId) {
    try { await cf('DELETE', base(scope, id) + '/' + ruleId); return 'deleted'; }
    catch (e) { if (isNotFound(e)) return 'already_gone'; throw e; }
  }

  async function patchMode(scope, id, item, mode) {
    const body = { mode, configuration: item.configuration, notes: typeof item.notes === 'string' ? item.notes : undefined };
    const j = await cf('PATCH', base(scope, id) + '/' + item.id, body);
    return normalize(j.result);
  }

  // 자산존 Allow 룰 먼저 지운다. 하나라도 못 지우면 throw → 계정 룰은 건드리지 않는다 (Allow 만 남는 고아 방지)
  async function deleteMates(id, item, out) {
    for (const zid of item.mates || []) {
      try { await cfDelete('zone', id, zid); out.paired.push(zid); }
      catch (e) { if (e instanceof RateLimited) throw e; out.pairedErrors.push(zid + ': ' + e.message); }
    }
    if (out.pairedErrors.length) throw new Error(id.zoneName + ' Allow 룰 삭제 실패로 계정 룰은 그대로 둠 (' + out.pairedErrors.join('; ') + ')');
  }

  // 항목을 차례로 처리한다. 429 를 받으면 거기서 멈추고 나머지는 처리하지 않은 채로 돌려준다.
  async function runItems(items, worker) {
    const results = [];
    let rate = null;
    for (const item of items) {
      if (rate) { results.push({ id: item.id, ok: false, skipped: true }); continue; }
      try { results.push({ id: item.id, ok: true, result: await worker(item) }); }
      catch (e) {
        // 실패한 항목도 그때까지 한 일(partial — 예: 이미 지운 자산존 Allow)을 돌려준다
        if (e instanceof RateLimited) { rate = e; results.push({ id: item.id, ok: false, skipped: true, result: e.partial }); }
        else results.push({ id: item.id, ok: false, error: e.message, result: e.partial });
      }
    }
    return { results, rateLimited: !!rate, retryAfter: rate ? rate.retryAfter : 0 };
  }

  // 요청 본문 검사 — 항목 id · 자산존 Allow id · configuration 모양, 호출 수 상한
  function checkItems(body, scope, perItem, needMates) {
    const fail = (m) => { throw new BadRequest(m); };
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) fail('items 가 비어 있습니다.');
    let est = 0;
    for (const it of items) {
      if (!it || typeof it.id !== 'string' || !ID_RE.test(it.id)) fail('잘못된 규칙 id 가 포함되어 있습니다.');
      if (needMates && !Array.isArray(it.mates)) {
        throw new Conflict('자산존(' + want + ') Allow 룰 목록을 확인하지 못해 계정 룰을 지우지 않았습니다. 새로고침한 뒤 다시 하세요. (그대로 지우면 자산존 Allow 룰이 고아로 남습니다)');
      }
      if (it.mates !== undefined) {
        if (scope !== 'account' || !Array.isArray(it.mates) || it.mates.length > 10 || !it.mates.every((m) => typeof m === 'string' && ID_RE.test(m))) {
          fail('잘못된 자산존 Allow 룰 id 가 포함되어 있습니다.');
        }
      }
      if (it.configuration !== undefined) {
        const c = it.configuration;
        if (!c || typeof c !== 'object' || !TARGETS.includes(c.target) || typeof c.value !== 'string' || c.value.length > 100) {
          fail('잘못된 configuration 이 포함되어 있습니다.');
        }
      }
      if (it.notes !== undefined && (typeof it.notes !== 'string' || it.notes.length > 1000)) fail('잘못된 notes');
      est += perItem(it);
    }
    if (est > MAX_CALLS) fail('한 번에 너무 많습니다 (Cloudflare 호출 ' + est + '회 > ' + MAX_CALLS + '회). 나눠서 보내세요.');
    return items;
  }

  const logEntry = (value, action, label) => ({
    id: Math.random().toString(36).slice(2, 10), ts: nowStamp(), zone: value || '(IP 없음)', zoneId: '', action, label,
  });

  // 이력 쓰기가 실패해도(KV 1초 1회 쓰기 제한, 하루 쓰기 한도) Cloudflare 에 이미 적용된 결과는 그대로 돌려준다
  async function safeLog(entries, out) {
    if (!entries.length) return;
    try { await log(entries); } catch (e) { out.logError = '변경 이력 기록 실패: ' + e.message; }
  }
  let zoneLabel = want;
  const pairedOnly = (x, what) => logEntry(x.result.value, 'ip-unpair',
    zoneLabel + ' Allow 룰 ' + x.result.paired.length + '건 삭제 — ' + what + ' 실패: ' + (x.error || 'Cloudflare API 한도'));

  const ok = (b) => ({ status: 200, body: Object.assign({ calls }, b) });
  const bad = (status, msg, extra) => ({ status, body: Object.assign({ error: msg, calls }, extra || {}) });

  return async function handle(method, path, query, body) {
    calls = 0;
    const scope = (query && query.get && query.get('scope')) || body.scope || 'account';
    if (scope !== 'account' && scope !== 'zone') return bad(400, '잘못된 scope');

    // 분류 규칙은 토큰 없이도 쓸 수 있다
    if (path === '/api/ip/filters' && method === 'GET') {
      const saved = await store.get('ip:filters', null);
      return ok(saved ? validateFilters(saved) : validateFilters(DEFAULT_FILTERS));
    }
    if (path === '/api/ip/filters' && method === 'PUT') {
      try { return ok(await store.put('ip:filters', validateFilters(body))); }
      catch (e) { return bad(400, e.message); }
    }
    if (path === '/api/ip/filters/reset' && method === 'POST') {
      return ok(await store.put('ip:filters', validateFilters(DEFAULT_FILTERS)));
    }

    if (path === '/api/ip/config' && method === 'GET') {
      const out = { configured: !!token, modes: MODES, rateBudget: config.ipRateBudget || 900, rateWindowSec: 300, maxCalls: MAX_CALLS, zoneName: want, zoneEnabled: pairing };
      if (!token) return ok(out);
      try {
        const id = await ids();
        return ok(Object.assign(out, { zoneName: id.zoneName, zoneEnabled: !!id.zoneId }));
      } catch (e) {
        if (e instanceof RateLimited) return bad(429, e.message, { rateLimited: true, retryAfter: e.retryAfter });
        // 자산존을 못 찾은 채로 목록을 열면 자산존 Allow 룰을 남긴 채 지우게 된다 — 성공(200)으로 돌려주지 않는다
        return bad(e.status === 403 || (e.codes || []).includes(10000) ? 403 : 503, e.message);
      }
    }

    if (!token) return bad(400, 'IP 룰용 토큰이 설정되지 않았습니다.');

    try {
      const id = await ids();
      zoneLabel = id.zoneName;
      if (scope === 'zone' && !id.zoneId) return bad(400, '자산존이 설정되지 않았습니다.');

      // 목록 — 한 페이지(1000건)씩
      if (path === '/api/ip/rules' && method === 'GET') {
        const page = Math.max(1, Math.min(500, Number(query.get('page')) || 1));
        const j = await cf('GET', base(scope, id) + '?page=' + page + '&per_page=' + PER_PAGE);
        const list = j.result || [];
        const rules = [];
        for (const r of list) {
          // 존 목록에는 계정 룰이 상속되어 섞여 온다 — 그 존 소유 룰만
          if (scope === 'zone' && r.scope && r.scope.id && r.scope.id !== id.zoneId) continue;
          rules.push(normalize(r));
        }
        const perPage = (j.result_info && j.result_info.per_page) || PER_PAGE;
        return ok({ scope, page, rules, more: list.length > 0 && list.length >= perPage, zoneName: id.zoneName });
      }

      // Action 변경 — 항목당 1회
      if (path === '/api/ip/mode' && method === 'POST') {
        if (!MODES.includes(body.mode)) return bad(400, '잘못된 mode: ' + body.mode);
        const items = checkItems(body, scope, () => 1);
        const out = await runItems(items, (it) => patchMode(scope, id, it, body.mode));
        const entries = out.results.filter((r) => r.ok).map((r) => logEntry(r.result.value, 'ip-mode', 'IP 룰 Action → ' + MODE_LABEL[body.mode] + (scope === 'zone' ? ' (' + id.zoneName + ')' : '')));
        await safeLog(entries, out);
        return ok(out);
      }

      // 삭제 — 계정 룰이면 자산존 Allow 룰 먼저
      if (path === '/api/ip/delete' && method === 'POST') {
        const items = checkItems(body, scope, (it) => 1 + ((it.mates || []).length), scope === 'account' && pairing);
        const out = await runItems(items, async (it) => {
          const r = { value: it.value || '', paired: [], pairedErrors: [], note: '' };
          try {
            if (scope === 'account') await deleteMates(id, it, r);
            if ((await cfDelete(scope, id, it.id)) === 'already_gone') r.note = '이미 Cloudflare 에서 삭제되어 있던 규칙';
          } catch (e) { e.partial = r; throw e; }
          return r;
        });
        const entries = out.results.filter((x) => x.ok).map((x) => logEntry(x.result.value, 'ip-delete',
          'IP 룰 삭제' + (scope === 'zone' ? ' (' + id.zoneName + ')' : '') + (x.result.paired.length ? ' + ' + id.zoneName + ' Allow ' + x.result.paired.length + '건' : '') + (x.result.note ? ' — ' + x.result.note : '')));
        // 계정 룰은 실패했어도 자산존 Allow 를 이미 지웠으면 그것도 남긴다
        for (const x of out.results) if (!x.ok && x.result && x.result.paired.length) entries.push(pairedOnly(x, '계정 룰 삭제'));
        await safeLog(entries, out);
        return ok(out);
      }

      // 위험차단 — 자산존 Allow 룰만 삭제(unpair). setBlock 이면 계정 룰 Action 도 Block
      // Allow 가 Block 보다 우선하므로 순서는 Allow 삭제 → Block
      if (path === '/api/ip/block' && method === 'POST') {
        if (scope !== 'account') return bad(400, '위험차단은 계정 룰에서만 합니다.');
        const setBlock = !!body.setBlock;
        const items = checkItems(body, scope, (it) => (it.mates || []).length + (setBlock && it.mode !== 'block' ? 1 : 0), pairing);
        const out = await runItems(items, async (it) => {
          const r = { value: it.value || '', paired: [], pairedErrors: [], modeChanged: false, gone: false, rule: null };
          try {
            await deleteMates(id, it, r);
            if (setBlock && it.mode !== 'block') {
              try { r.rule = await patchMode(scope, id, it, 'block'); r.modeChanged = true; }
              catch (e) { if (e instanceof RateLimited || !isNotFound(e)) throw e; r.gone = true; }
            }
          } catch (e) { e.partial = r; throw e; }
          return r;
        });
        const entries = out.results.filter((x) => x.ok && (x.result.paired.length || x.result.modeChanged)).map((x) => logEntry(x.result.value, setBlock ? 'ip-block' : 'ip-unpair',
          (x.result.paired.length ? id.zoneName + ' Allow 룰 삭제' : '') + (x.result.modeChanged ? (x.result.paired.length ? ' + ' : '') + 'Action → Block' : '')));
        for (const x of out.results) if (!x.ok && x.result && x.result.paired.length) entries.push(pairedOnly(x, setBlock ? 'Block 변경' : '위험차단'));
        await safeLog(entries, out);
        return ok(out);
      }

      return bad(404, 'NOT_FOUND');
    } catch (e) {
      if (e instanceof RateLimited) return bad(429, e.message, { rateLimited: true, retryAfter: e.retryAfter });
      if (e instanceof BadRequest) return bad(400, e.message);
      if (e instanceof Conflict) return bad(409, e.message);
      await dropIdsIfStale(e);
      return bad(e.status === 403 || (e.codes || []).includes(10000) ? 403 : 500, e.message);
    }
  };
}
