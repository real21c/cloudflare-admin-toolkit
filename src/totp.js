// 구글 OTP (TOTP, RFC 6238) — 외부 라이브러리 없이 WebCrypto 로 계산한다
//
//   비밀키 20바이트(base32) · HMAC-SHA1 · 30초 · 6자리 — 구글 OTP 앱 기본값
//
// 이 파일은 계산만 한다. 사람별 등록·사용중지와 KV 키는 otp.js,
// 세션(epoch · gen)은 auth.js / worker.js 참고.

import qrcode from './vendor/qrcode.mjs';

const STEP = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function newSecret() {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

async function codeAt(secret, counter) {
  const key = await crypto.subtle.importKey(
    'raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256); }
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const counterNow = (now) => Math.floor((now || Date.now()) / 1000 / STEP);

// 맞으면 그 코드의 counter, 틀리면 -1. 휴대폰 시계 오차를 감안해 앞뒤 1칸(±30초)까지 본다.
export async function verifyCode(secret, code, now) {
  const given = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return -1;
  const c = counterNow(now);
  for (const d of [0, -1, 1]) {
    if ((await codeAt(secret, c + d)) === given) return c + d;
  }
  return -1;
}

export function otpauthUri(secret, account, issuer) {
  return 'otpauth://totp/' + encodeURIComponent(issuer + ':' + account) +
    '?secret=' + secret + '&issuer=' + encodeURIComponent(issuer) +
    '&algorithm=SHA1&digits=' + DIGITS + '&period=' + STEP;
}

// QR 은 Worker 안에서 SVG 로 만든다 — 비밀키가 외부 QR 서비스로 나가지 않는다
export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
}

export { codeAt };
