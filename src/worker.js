// Cloudflare Workers 엔트리
//
//   - 정적 파일은 Workers Assets(env.ASSETS)로 서빙
//   - 저장소는 KV
//   - 모든 요청은 비밀번호 로그인 뒤에만 통과 (구글 OTP 를 등록했으면 OTP 도)
//
// 필요한 시크릿:
//   CF_API_TOKEN     Cloudflare API 토큰 (Zone:Read / DNS:Edit / Zone Settings:Edit / Cache Rules:Edit)
//                    IP 룰 메뉴도 이 토큰을 쓴다 → Account Firewall Access Rules:Edit, Zone Firewall Services:Edit 추가
//   CF_IP_TOKEN      (선택) IP 룰용 토큰을 따로 두려면
//   PASSWORD_PREFIX  비밀번호 접두어. 실제 비밀번호는 <접두어>!<오늘 날짜 2자리>
//   SESSION_SECRET   세션 쿠키 서명용 임의 문자열

import { createApi } from './api.js';
import { createStore } from './store-kv.js';
import {
  expectedPassword, makeSession, parseSession,
  readCookie, sessionCookie, clearCookie, COOKIE_NAME, safeEqual, loginPage,
} from './auth.js';
import { newSecret, verifyCode, otpauthUri, qrSvg } from './totp.js';
import {
  loadDevices, saveDevices, putUse, getUse, newId, cleanName, stepUp, matchLogin, publicList, countFail, failCount,
} from './otp.js';
import { nowStamp, monthKey } from './core.js';
import { loadSettings, applySettings, pickDefaults } from './settings.js';

// 구글 OTP 앱에 표시되는 이름 (wrangler.jsonc 의 OTP_ISSUER)
const DEFAULT_OTP_ISSUER = 'CF Admin';

const json = (status, body, extra) =>
  new Response(JSON.stringify(body), {
    status,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      extra || {}
    ),
  });

const html = (status, body, extra) =>
  new Response(body, {
    status,
    headers: Object.assign(
      { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      extra || {}
    ),
  });

// 로그인 실패 제한 — IP당 첫 실패부터 10분 안에 10번 틀리면 막는다 (고정 창).
// 성공한 로그인은 세지 않고, 성공하면 그 IP 의 실패 기록을 지운다
// (날짜 비밀번호를 가끔 틀리는 정도로 사무실 IP 전체가 막히지 않게)
const LOGIN_MAX = 10;
const LOGIN_WINDOW = 600;
const loginBlocked = async (kv, ip) => (await failCount(kv, 'try:' + ip, LOGIN_WINDOW)) >= LOGIN_MAX;
const loginFailed = (kv, ip) => countFail(kv, 'try:' + ip, LOGIN_WINDOW);

const epochGet = async (kv) => Number((await kv.get('sess:epoch')) || 0);

async function epochBump(kv) {
  const next = (await epochGet(kv)) + 1;
  await kv.put('sess:epoch', String(next));
  return next;
}

const cookieFor = async (env, epoch, dev) =>
  sessionCookie(await makeSession(env.SESSION_SECRET, epoch, dev ? dev.id : '-', dev ? dev.gen || 0 : 0));

// 쿠키 → 로그인 상태. 무효면 null.
//   OTP 가 하나도 없으면 비밀번호 세션('-')만 통과
//   OTP 가 있으면 그 사람이 목록에 있고 · 사용 중이고 · gen 이 같아야 통과 (사용중지하면 바로 끊김)
async function sessionOf(request, env) {
  const kv = env.BDM_KV;
  const s = await parseSession(env.SESSION_SECRET, readCookie(request, COOKIE_NAME));
  if (!s) return null;
  if (s.epoch !== (await epochGet(kv))) return null;
  const list = await loadDevices(kv);
  if (!list.length) return s.dev === '-' ? { dev: null, list } : null;
  const dev = list.find((d) => d.id === s.dev);
  if (!dev || !dev.enabled || (dev.gen || 0) !== s.gen) return null;
  return { dev, list };
}

const OTP_FAIL = {
  wrong: '현재 OTP 코드가 맞지 않습니다.',
  reused: '방금 사용한 코드입니다. 앱의 코드가 바뀐 뒤 새 코드를 입력하세요.',
  locked: '관리자 확인 코드를 여러 번 틀렸습니다. 10분 뒤에 다시 하세요.',
};
const STALE = '목록이 바뀌었습니다. 새로고침한 뒤 다시 하세요.';

// OTP 관리 기록을 변경 이력에 남긴다 (도메인 칸 = '2단계 인증', by = 누가 했는지).
// 이력 쓰기가 실패해도(KV 쓰기 제한 등) OTP 작업은 실패시키지 않는다.
async function otpLog(env, action, label, by) {
  try {
    const entry = { id: Math.random().toString(36).slice(2, 10), ts: nowStamp(), zone: '2단계 인증', zoneId: '', action, label };
    if (by) entry.by = by;
    await createStore(env.BDM_KV).update('log:' + monthKey(), [], (cur) => (cur || []).concat([entry]));
  } catch (e) { /* 무시 */ }
}

// 대시보드에서 호출하는 OTP 관리 (로그인된 상태에서만 온다)
async function handleOtp(request, env, path, url, sess) {
  const kv = env.BDM_KV;
  const { dev: me } = sess;
  let list = sess.list;
  const isOwner = !list.length || !!(me && me.owner);
  let body = {};
  if (request.method === 'POST') {
    try { body = await request.json(); } catch (e) { return json(400, { error: 'JSON 파싱 실패' }); }
  }
  const ownerOnly = () => json(403, { error: '관리자만 할 수 있습니다.' });

  if (path === '/auth/otp/status' && request.method === 'GET') {
    return json(200, {
      enabled: list.length > 0,
      me: me ? { id: me.id, name: me.name, owner: !!me.owner } : null,
      isOwner,
      devices: await publicList(kv, list),
    });
  }

  // 새 키 만들기
  //   first — 아무도 없을 때. 처음 등록한 사람이 관리자가 된다
  //   add   — 관리자가 다른 사람을 추가 (관리자의 현재 OTP 확인)
  //   rekey — 관리자 휴대폰 변경 (관리자의 현재 OTP 확인)
  if (path === '/auth/otp/setup' && request.method === 'POST') {
    let pending;
    const mode = body.mode;
    if (!['first', 'add', 'rekey'].includes(mode)) return json(400, { error: '알 수 없는 작업' });
    // 화면이 예전 상태면 거절 — 예) 전체 해제 뒤 예전 화면에서 '추가'를 누르면 그 사람이 관리자가 되어 버린다
    if ((mode === 'first') !== !list.length) return json(409, { error: STALE });
    if (mode === 'first') {
      pending = { mode: 'first', name: cleanName(body.name) || '관리자' };
    } else {
      if (!isOwner) return ownerOnly();
      const r = await stepUp(kv, me, body.code);
      if (r !== 'ok') return json(r === 'locked' ? 429 : 400, { error: OTP_FAIL[r] });
      if (mode === 'rekey') {
        pending = { mode: 'rekey', name: me.name, by: me.id };
      } else {
        const name = cleanName(body.name);
        if (!name) return json(400, { error: '이름을 입력하세요.' });
        pending = { mode: 'add', name, by: me.id };
      }
    }
    pending.secret = newSecret();
    await kv.put('otp:pending', JSON.stringify(pending), { expirationTtl: 600 });
    const issuer = (await loadSettings(createStore(kv))).otpIssuer || env.OTP_ISSUER || DEFAULT_OTP_ISSUER;
    const uri = otpauthUri(pending.secret, pending.name, issuer);
    return json(200, {
      secret: pending.secret, uri, svg: qrSvg(uri), account: pending.name, issuer, mode: pending.mode,
    });
  }

  // 앱에 뜬 코드로 확인되면 그때 적용 — 스캔을 잘못해 잠기는 걸 막는다
  if (path === '/auth/otp/enable' && request.method === 'POST') {
    const pending = await kv.get('otp:pending', 'json');
    if (!pending) return json(400, { error: '등록 시간이 지났습니다. 다시 시작하세요.' });
    if (pending.mode === 'first') {
      if (list.length) return json(400, { error: '그 사이 다른 사람이 먼저 등록했습니다. 다시 시작하세요.' });
    } else if (!isOwner || !me || me.id !== pending.by) {
      return ownerOnly();
    }
    const c = await verifyCode(pending.secret, body.code);
    if (c < 0) return json(400, { error: 'OTP 코드가 맞지 않습니다. 앱에 표시된 6자리를 입력하세요.' });
    await kv.delete('otp:pending');
    const now = nowStamp();

    if (pending.mode === 'first') {
      const dev = { id: newId(), name: pending.name, secret: pending.secret, since: now, enabled: true, owner: true, gen: 0 };
      await saveDevices(kv, [dev]);
      await putUse(kv, dev.id, { counter: c, at: null });
      await kv.delete('otp:last'); // 예전 방식(한 명) 흔적
      const epoch = await epochBump(kv); // 비밀번호만으로 들어와 있던 세션 전부 끊기. 지금 창은 이어간다
      await otpLog(env, 'otp-first', 'OTP 등록 — ' + dev.name + ' (관리자) · 2단계 인증 켜짐', dev.name);
      return json(200, { ok: true, name: dev.name }, { 'Set-Cookie': await cookieFor(env, epoch, dev) });
    }

    if (pending.mode === 'add') {
      const dev = { id: newId(), name: pending.name, secret: pending.secret, since: now, enabled: true, owner: false, gen: 0 };
      list = list.concat([dev]);
      await saveDevices(kv, list);
      await putUse(kv, dev.id, { counter: c, at: null });
      await otpLog(env, 'otp-add', 'OTP 추가 — ' + dev.name, me.name);
      return json(200, { ok: true, name: dev.name });
    }

    // rekey — 관리자의 예전 휴대폰으로 로그인해 둔 다른 창은 끊고, 지금 창은 이어간다
    const owner = list.find((d) => d.id === pending.by);
    if (!owner) return ownerOnly();
    owner.secret = pending.secret;
    owner.since = now;
    owner.gen = (owner.gen || 0) + 1;
    await saveDevices(kv, list);
    const use = await getUse(kv, owner.id);
    await putUse(kv, owner.id, { counter: c, at: use.at });
    await otpLog(env, 'otp-rekey', 'OTP 휴대폰 변경 — ' + owner.name, owner.name);
    return json(200, { ok: true, name: owner.name }, { 'Set-Cookie': await cookieFor(env, await epochGet(kv), owner) });
  }

  // 한 사람 관리 — 이름 변경 · 사용중지 · 다시 사용 · 삭제
  if (path === '/auth/otp/device' && request.method === 'POST') {
    if (!list.length || !isOwner) return ownerOnly();
    const target = list.find((d) => d.id === body.id);
    if (!target) return json(404, { error: '없는 OTP 입니다. 목록을 새로 여세요.' });
    const act = body.action;
    const before = target.name;
    let label;
    if (act === 'rename') {
      const name = cleanName(body.name);
      if (!name) return json(400, { error: '이름을 입력하세요.' });
      target.name = name;
      label = 'OTP 이름 변경 — ' + before + ' → ' + name;
    } else if (act === 'disable' || act === 'delete') {
      if (target.owner) return json(400, { error: '관리자 OTP 는 사용중지하거나 삭제할 수 없습니다.' });
      if (act === 'disable') {
        target.enabled = false;
        target.gen = (target.gen || 0) + 1; // 그 사람이 로그인해 둔 창을 바로 끊는다
        label = 'OTP 사용중지 — ' + before;
      } else {
        list = list.filter((d) => d.id !== target.id);
        await kv.delete('otp:use:' + target.id);
        await kv.delete('otp:fail:' + target.id);
        label = 'OTP 삭제 — ' + before;
      }
    } else if (act === 'enable') {
      target.enabled = true;
      label = 'OTP 다시 사용 — ' + before;
    } else {
      return json(400, { error: '알 수 없는 작업' });
    }
    await saveDevices(kv, list);
    await otpLog(env, 'otp-' + act, label, me.name);
    return json(200, { ok: true });
  }

  // 전체 해제 — 비밀번호만으로 로그인하게 된다 (관리자의 현재 OTP 확인)
  if (path === '/auth/otp/off' && request.method === 'POST') {
    if (!list.length) return json(409, { error: STALE });
    if (!isOwner) return ownerOnly();
    const r = await stepUp(kv, me, body.code);
    if (r !== 'ok') return json(r === 'locked' ? 429 : 400, { error: OTP_FAIL[r] });
    await saveDevices(kv, []);
    for (const d of list) { await kv.delete('otp:use:' + d.id); await kv.delete('otp:fail:' + d.id); }
    await kv.delete('otp:pending');
    const epoch = await epochBump(kv);
    await otpLog(env, 'otp-off', '2단계 인증 전체 해제 — ' + list.length + '명 OTP 삭제 · 비밀번호만으로 로그인', me.name);
    return json(200, { ok: true }, { 'Set-Cookie': await cookieFor(env, epoch, null) });
  }

  return json(404, { error: 'NOT_FOUND' });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const kv = env.BDM_KV;

    if (!env.PASSWORD_PREFIX || !env.SESSION_SECRET) {
      return html(500, '<p>PASSWORD_PREFIX / SESSION_SECRET 시크릿이 설정되지 않았습니다.</p>');
    }

    // ── 로그인 ────────────────────────────────────────────
    if (path === '/login') {
      const list = await loadDevices(kv);
      const otpOn = list.length > 0;
      if (request.method === 'GET') return html(200, loginPage('', otpOn));

      if (await loginBlocked(kv, ip)) {
        return html(429, loginPage('여러 번 틀려서 잠시 막혔습니다. 10분 뒤에 다시 하세요.', otpOn));
      }

      const form = await request.formData();
      const given = String(form.get('password') || '');
      const want = expectedPassword(env.PASSWORD_PREFIX);

      // 어느 쪽이 틀렸는지는 알려주지 않는다. OTP 는 비밀번호가 맞을 때만 확인한다
      const passOk = safeEqual(given, want);
      let dev = null;
      if (passOk && otpOn) dev = (await matchLogin(kv, list, form.get('otp'), nowStamp())).device;
      if (!passOk || (otpOn && !dev)) {
        await loginFailed(kv, ip);
        return html(401, loginPage(otpOn ? '비밀번호 또는 OTP 가 맞지 않습니다. (같은 OTP 는 한 번만 쓸 수 있습니다)' : '비밀번호가 맞지 않습니다.', otpOn));
      }

      await kv.delete('try:' + ip);
      return new Response(null, {
        status: 302,
        headers: { Location: '/', 'Set-Cookie': await cookieFor(env, await epochGet(kv), dev) },
      });
    }

    if (path === '/logout') {
      return new Response(null, {
        status: 302,
        headers: { Location: '/login', 'Set-Cookie': clearCookie() },
      });
    }

    // ── 인증 확인 ─────────────────────────────────────────
    const sess = await sessionOf(request, env);
    if (!sess) {
      if (path.startsWith('/api/') || path.startsWith('/auth/')) {
        return json(401, { error: 'UNAUTHORIZED', message: '세션이 만료되었습니다.' });
      }
      return html(200, loginPage('', (await loadDevices(kv)).length > 0));
    }

    // ── 구글 OTP 관리 ─────────────────────────────────────
    if (path.startsWith('/auth/otp/')) return handleOtp(request, env, path, url, sess);

    // ── API ───────────────────────────────────────────────
    if (path.startsWith('/api/')) {
      const store = createStore(kv);
      const base = {
        token: env.CF_API_TOKEN || '',
        serverIp: env.SERVER_IP || '',
        defaultGroup: env.DEFAULT_GROUP || '',
        concurrency: Number(env.CONCURRENCY || 6),
        cacheTtlMinutes: Number(env.CACHE_TTL_MINUTES || 10),
        // Workers 무료 플랜은 요청 1건당 외부 subrequest 50개 제한.
        // zone 하나당 조회 2 + 변경 몇 건이므로 5개씩 끊는다.
        maxZonesPerCall: Number(env.MAX_ZONES_PER_CALL || 5),
        // 변경 이력에 남길 이름 — 로그인한 OTP 의 이름 (비밀번호만이면 없음)
        actor: sess.dev ? sess.dev.name : null,
        // IP 룰 — 따로 둔 토큰이 없으면 도메인 토큰을 쓴다 (그 토큰에 IP 룰 권한을 추가하면 된다)
        ipToken: env.CF_IP_TOKEN || env.CF_API_TOKEN || '',
        ipAccountId: env.IP_ACCOUNT_ID || '',
        ipPairZoneId: env.IP_PAIR_ZONE_ID || '',
        ipPairZoneName: env.IP_PAIR_ZONE_NAME || '',
        ipRateBudget: Number(env.IP_RATE_BUDGET || 900),
        otpIssuer: env.OTP_ISSUER || DEFAULT_OTP_ISSUER,
      };
      // 설정 메뉴에서 바꾼 값을 기본값(wrangler.jsonc) 위에 덮는다. 설정을 바꿀 수 있는 사람 = OTP 관리자 (OTP 가 없으면 로그인한 사람)
      const config = Object.assign(applySettings(base, await loadSettings(store)), {
        defaults: pickDefaults(base),
        canAdmin: !sess.list.length || !!(sess.dev && sess.dev.owner),
      });

      const handle = createApi({ store, config });

      // POST 뿐 아니라 PUT(분류 규칙 저장) 등도 본문을 읽는다
      let body = {};
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        try { body = await request.json(); } catch (e) { return json(400, { error: 'JSON 파싱 실패' }); }
      }

      try {
        const out = await handle(request.method, path, url.searchParams, body);
        return json(out.status, out.body);
      } catch (err) {
        return json(500, { error: String(err.message || err) });
      }
    }

    // ── 정적 파일 ─────────────────────────────────────────
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    out.headers.set('Cache-Control', 'no-store');
    return out;
  },
};
