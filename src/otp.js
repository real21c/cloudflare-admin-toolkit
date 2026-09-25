// 구글 OTP — 사람별 등록 · 사용중지 (KV)
//
//   otp:devices     [{ id, name, secret, since, enabled, owner, gen }]   목록. 관리자만 바꾼다
//   otp:use:<id>    { counter, at }   마지막으로 쓴 코드(재사용 방지)와 마지막 로그인 시각. 로그인 때만 쓴다
//   otp:pending     { secret, name, mode, by }   등록 중인 키 (10분 뒤 자동 삭제)
//
// 목록과 사용 기록을 나눈 이유: 로그인할 때 목록을 다시 쓰면, 같은 순간 관리자가 한
// 사용중지를 로그인 쪽 쓰기가 덮어써서 되살릴 수 있다.
//
// 처음 등록한 사람이 관리자(owner). 관리자는 사용중지·삭제할 수 없고, 항상 사용 중이다.
// 그래서 목록이 비어 있지 않으면 로그인에 OTP 가 반드시 필요하다.
//
// gen — 사용중지하거나 휴대폰을 바꾸면 올린다. 세션 쿠키에 gen 이 들어 있어서
// 값이 다른 세션(= 그 전에 로그인해 둔 창)은 바로 끊긴다.
//
// 모두 휴대폰을 잃어버렸을 때 (프로젝트 폴더에서):
//   npx wrangler kv key delete --binding BDM_KV otp:devices --remote
//   → 비밀번호만으로 로그인 → 다시 등록 (처음 등록한 사람이 관리자)

import { verifyCode } from './totp.js';

export const NAME_MAX = 30;

export async function loadDevices(kv) {
  const v = await kv.get('otp:devices', 'json');
  return Array.isArray(v) ? v : [];
}

export async function saveDevices(kv, list) {
  if (list.length) await kv.put('otp:devices', JSON.stringify(list));
  else await kv.delete('otp:devices');
}

export async function getUse(kv, id) {
  return (await kv.get('otp:use:' + id, 'json')) || { counter: -1, at: null };
}

export async function putUse(kv, id, use) {
  await kv.put('otp:use:' + id, JSON.stringify(use));
}

export const newId = () =>
  'd' + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');

export function cleanName(v) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  return s.slice(0, NAME_MAX);
}

// 한 사람의 코드 확인 + 재사용 방지. 결과 'ok' | 'wrong' | 'reused'
// login=true 면 마지막 로그인 시각도 남긴다.
export async function checkDevice(kv, device, code, login, now) {
  const c = await verifyCode(device.secret, code);
  if (c < 0) return 'wrong';
  const use = await getUse(kv, device.id);
  if (c <= use.counter) return 'reused';
  await putUse(kv, device.id, { counter: c, at: login ? now : use.at });
  return 'ok';
}

// 고정 창 실패 카운터 — 첫 실패부터 windowSec 동안 센다. 이후 실패가 창을 뒤로 밀지 않는다.
// KV 값: { n, start }  (expiration 은 절대 시각이고 최소 60초 뒤여야 한다)
export async function countFail(kv, key, windowSec) {
  const now = Date.now();
  let v = await kv.get(key, 'json');
  if (!v || typeof v !== 'object' || now - v.start >= windowSec * 1000) v = { n: 0, start: now };
  v.n += 1;
  const exp = Math.max(Math.floor((v.start + windowSec * 1000) / 1000), Math.floor(now / 1000) + 60);
  await kv.put(key, JSON.stringify(v), { expiration: exp });
  return v.n;
}
export async function failCount(kv, key, windowSec) {
  const v = await kv.get(key, 'json');
  if (!v || typeof v !== 'object') return 0;
  return Date.now() - v.start >= windowSec * 1000 ? 0 : v.n;
}

// 관리자 확인(추가 · 휴대폰 변경 · 전체 해제)용. 틀린 코드를 세서 10분에 5번 틀리면 잠근다.
// 로그인한 창을 누가 가로채도 코드를 계속 찍어 볼 수 없게. 결과 'ok' | 'wrong' | 'reused' | 'locked'
export const STEP_MAX = 5;
export const STEP_LOCK_SEC = 600;
export async function stepUp(kv, device, code) {
  const key = 'otp:fail:' + device.id;
  const n = await failCount(kv, key, STEP_LOCK_SEC);
  if (n >= STEP_MAX) return 'locked';
  const r = await checkDevice(kv, device, code, false);
  if (r === 'wrong') await countFail(kv, key, STEP_LOCK_SEC);
  else if (r === 'ok' && n) await kv.delete(key);
  return r;
}

// 로그인 — 사용 중인 사람들 가운데 코드가 맞는 사람을 찾는다
export async function matchLogin(kv, list, code, now) {
  let reused = false;
  for (const d of list) {
    if (!d.enabled) continue;
    const r = await checkDevice(kv, d, code, true, now);
    if (r === 'ok') return { device: d };
    if (r === 'reused') reused = true;
  }
  return { device: null, reason: reused ? 'reused' : 'wrong' };
}

// 화면에 보낼 목록 — 비밀키는 절대 내보내지 않는다
export async function publicList(kv, list) {
  const out = [];
  for (const d of list) {
    const use = await getUse(kv, d.id);
    out.push({ id: d.id, name: d.name, since: d.since, enabled: !!d.enabled, owner: !!d.owner, lastLogin: use.at });
  }
  return out;
}
