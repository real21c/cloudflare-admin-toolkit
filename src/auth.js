// 비밀번호 인증 (Workers 용)
//
// 비밀번호 = <접두어> + '!' + 오늘 날짜(일, 2자리, KST)
//   예) 접두어가 root 이고 오늘이 22일이면  root!22
//
// 접두어는 소스에 두지 않고 시크릿(PASSWORD_PREFIX)으로 받는다.
// 통과하면 HMAC 서명 쿠키를 주고, 이후 요청은 쿠키만 확인한다.
// 구글 OTP 를 등록했으면 로그인 때 6자리 코드도 받는다 (totp.js).

const COOKIE = 'bdm_session';
const SESSION_HOURS = 12;

// KST 기준 오늘 날짜(일) 두 자리
export function todaySuffix(now) {
  const kst = new Date((now || Date.now()) + 9 * 60 * 60 * 1000);
  return String(kst.getUTCDate()).padStart(2, '0');
}

export function expectedPassword(prefix, now) {
  return prefix + '!' + todaySuffix(now);
}

// 길이/내용이 새어나가지 않도록 상수 시간 비교
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}

// 세션 = 만료.epoch.OTP주인.gen.서명
//   epoch — OTP 를 처음 켜거나 전체 해제할 때 올라가는 숫자. 값이 다르면 무효
//   dev   — 어느 사람의 OTP 로 들어왔는지 (비밀번호만이면 '-')
//   gen   — 그 사람을 사용중지하거나 휴대폰을 바꾸면 올라가는 숫자. 값이 다르면 무효
export async function makeSession(secret, epoch, dev, gen) {
  const exp = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const payload = [exp, epoch || 0, dev || '-', gen || 0].join('.');
  return payload + '.' + (await hmac(secret, payload));
}

// 서명과 만료만 확인해서 내용을 돌려준다. epoch·dev·gen 비교는 부르는 쪽(worker)이 한다.
// 예전 형식(만료.epoch)은 dev '-' 로 읽는다.
export async function parseSession(secret, token) {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!safeEqual(sig, await hmac(secret, payload))) return null;
  const [exp, epoch, dev, gen] = payload.split('.');
  if (!Number.isFinite(Number(exp)) || Date.now() >= Number(exp)) return null;
  return { epoch: Number(epoch || 0), dev: dev || '-', gen: Number(gen || 0) };
}

export function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionCookie(value) {
  return COOKIE + '=' + value +
    '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + SESSION_HOURS * 3600;
}

export const clearCookie = () => COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
export const COOKIE_NAME = COOKIE;
export { safeEqual };

// ── 로그인 화면 ────────────────────────────────────────────
export function loginPage(message, otpOn) {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cloudflare Admin Toolkit</title>
<style>
  :root { --bg:#f5f5f5; --panel:#fff; --line:#d9d9d9; --text:#313131; --dim:#6b6b6b;
          --orange:#f6821f; --blue:#0051c3; --red:#bd2527; --redbg:#fbeaea; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#1d1d1d; --panel:#262626; --line:#3a3a3a; --text:#e3e3e3; --dim:#a5a5a5;
    --blue:#6ba4ff; --red:#f06a6c; --redbg:#301718; } }
  *{box-sizing:border-box} html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--text);display:flex;align-items:center;
       justify-content:center;font:400 14px/1.5 -apple-system,"Segoe UI","Malgun Gothic",sans-serif}
  form{background:var(--panel);border:1px solid var(--line);padding:28px;width:340px;max-width:92vw}
  .logo{display:flex;align-items:center;gap:9px;font-weight:600;font-size:15px;margin-bottom:20px}
  label{display:block;font-size:11.5px;font-weight:600;color:var(--dim);
        letter-spacing:.03em;margin-bottom:6px}
  input{width:100%;height:38px;padding:0 11px;font:inherit;color:var(--text);
        background:var(--bg);border:1px solid var(--line);border-radius:0}
  input:focus{outline:2px solid var(--blue);outline-offset:1px}
  button{width:100%;height:38px;margin-top:14px;font:inherit;font-weight:600;
         background:var(--blue);color:#fff;border:none;border-radius:0;cursor:pointer}
  .err{background:var(--redbg);color:var(--red);padding:9px 11px;margin-bottom:14px;font-size:13px}
</style></head><body>
<form method="POST" action="/login">
  <div class="logo">
    <svg width="26" height="26" viewBox="0 0 24 24"><path fill="#f6821f" d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>
    Cloudflare Admin Toolkit
  </div>
  ${message ? '<div class="err">' + message + '</div>' : ''}
  <label for="p">비밀번호</label>
  <input id="p" name="password" type="password" autocomplete="current-password" autofocus>
  ${otpOn ? `<label for="o" style="margin-top:14px">구글 OTP</label>
  <input id="o" name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="6자리">` : ''}
  <button type="submit">로그인</button>
</form>
</body></html>`;
}
