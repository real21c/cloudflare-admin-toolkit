// cloudflare-admin-toolkit — 로컬 실행 서버
//
//   node server.mjs        →  http://127.0.0.1:8790
//
// 의존성 0. Node 내장 모듈만 사용한다.
// API 로직은 src/api.js 에 있고 Workers(src/worker.js) 와 공유한다.
// 로컬은 127.0.0.1 바인딩이라 외부에서 못 붙으므로 로그인을 두지 않는다.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApi } from './src/api.js';
import { createStore } from './src/store-file.js';
import { loadSettings, applySettings, pickDefaults } from './src/settings.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = Number(portArg ? portArg.slice(7) : process.env.PORT || 8790);
const HOST = '127.0.0.1'; // 외부 노출 금지

// ─────────────────────────────────────────────────────────────
let config = {
  token: '',
  concurrency: 6,
  cacheTtlMinutes: 10,
  serverIp: '',
  defaultGroup: '',
  maxZonesPerCall: 999, // 로컬은 subrequest 제한이 없다
};
try {
  config = Object.assign(config, JSON.parse(await readFile(join(ROOT, 'config.json'), 'utf8')));
} catch (e) {
  if (e.code !== 'ENOENT') {
    console.error('config.json 을 읽을 수 없습니다:', e.message);
    process.exit(1);
  }
}
if (!config.token) config.token = process.env.CF_API_TOKEN || '';
// IP 룰 — 따로 둔 토큰(ipToken)이 없으면 도메인 토큰을 쓴다
if (!config.ipToken) config.ipToken = process.env.CF_IP_TOKEN || config.token;
if (config.ipPairZoneName === undefined) config.ipPairZoneName = '';
if (config.ipRateBudget === undefined) config.ipRateBudget = 900;
if (!config.otpIssuer) config.otpIssuer = 'CF Admin'; // 설정 메뉴의 기본값 표시용 (로컬은 OTP 가 없음)

const store = createStore();
// 설정 메뉴에서 바꾼 값(data/settings.json)을 요청마다 config.json 값 위에 덮는다. 로컬은 로그인이 없으니 누구나 바꿀 수 있다
async function handle(method, path, query, body) {
  const cfg = Object.assign(applySettings(config, await loadSettings(store)), { defaults: pickDefaults(config), canAdmin: true });
  return createApi({ store, config: cfg })(method, path, query, body);
}

// ─────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('요청이 너무 큽니다')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 파싱 실패')); }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST);
  try {
    if (url.pathname.startsWith('/api/')) {
      const body = req.method !== 'GET' && req.method !== 'HEAD' ? await readBody(req) : {};
      const out = await handle(req.method, url.pathname, url.searchParams, body);
      return sendJson(res, out.status, out.body);
    }
    return await serveStatic(res, url.pathname);
  } catch (err) {
    console.error('[error]', url.pathname, err);
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  cloudflare-admin-toolkit');
  console.log('  → http://' + HOST + ':' + PORT);
  console.log('');
  if (!config.token) {
    console.log('  ⚠  config.json 에 API 토큰이 없습니다.');
    console.log('');
  }
});
