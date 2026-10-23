// D1 저장소 (Workers 용) — 테이블 세 개
//
//   app_data    키 → 값. 설정 · 그룹 · 조건식 · OTP · 로그인 기록. KV 처럼 만료 시각을 둘 수 있다
//   zone_state  도메인 상태 캐시 — 도메인 하나 = 한 줄
//   change_log  변경 이력 — 기록 하나 = 한 줄 (seq 순서 = 기록 순서)
//
// KV 는 무료 요금제에서 하루 쓰기 1,000번이라, 도메인 수백 개를 한꺼번에 바꾸는 날에는 모자랐다.
// D1 은 무료 요금제도 하루 10만 행까지 쓴다.
//
// createD1Kv   → KV 와 같은 모양(get · put · delete · list). OTP · 로그인 코드와 store-kv.js 가 그대로 쓴다
// createD1Data → 캐시 · 변경 이력. log-store.js 의 createStoreData 와 같은 모양
//
// 테이블은 처음 쓸 때 만든다 (설치 때 따로 준비할 것 없음).

export const TABLES = ['app_data', 'zone_state', 'change_log'];

export const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS app_data (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS zone_state (zone_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS change_log (seq INTEGER PRIMARY KEY, id TEXT NOT NULL, ts TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS change_log_id ON change_log (id)',
];

// isolate 하나에 한 번만 (실패하면 다음 요청에서 다시)
const ready = new WeakMap();
export function ensureSchema(db) {
  let p = ready.get(db);
  if (!p) {
    p = db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => { ready.delete(db); throw e; });
    ready.set(db, p);
  }
  return p;
}

const nowSec = () => Math.floor(Date.now() / 1000);

// 한 문장에 넣는 행 수 — 바인딩 값은 문장당 100개까지, 문장 하나도 너무 커지지 않게 크기로도 끊는다
function pack(items, perRow, sizeOf) {
  const maxRows = Math.floor(100 / perRow);
  const maxBytes = 512 * 1024;
  const out = [];
  let cur = [], bytes = 0;
  for (const it of items) {
    const n = sizeOf ? sizeOf(it) : 0;
    if (cur.length && (cur.length >= maxRows || bytes + n > maxBytes)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(it); bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
const marks = (n, row) => Array(n).fill(row).join(', ');

// ── KV 와 같은 모양 ─────────────────────────────────────────────
export function createD1Kv(db) {
  if (!db) throw new Error('D1 바인딩이 없습니다.');
  return {
    async get(key, type) {
      await ensureSchema(db);
      const row = await db.prepare('SELECT value FROM app_data WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)')
        .bind(key, nowSec()).first();
      if (!row) return null;
      return type === 'json' ? JSON.parse(row.value) : row.value;
    },

    // opts: { expiration: 절대 시각(초) } 또는 { expirationTtl: 초 } — KV 와 같다
    async put(key, value, opts) {
      await ensureSchema(db);
      const o = opts || {};
      const exp = o.expiration ? Math.floor(o.expiration) : o.expirationTtl ? nowSec() + Math.floor(o.expirationTtl) : null;
      const up = db.prepare('INSERT INTO app_data (key, value, expires_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at').bind(key, String(value), exp);
      // 만료 있는 값을 쓸 때 지난 것들을 같이 치운다 (KV 는 저절로 사라지지만 D1 은 남는다)
      if (exp === null) await up.run();
      else await db.batch([up, db.prepare('DELETE FROM app_data WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(nowSec())]);
    },

    async delete(key) {
      await ensureSchema(db);
      await db.prepare('DELETE FROM app_data WHERE key = ?').bind(key).run();
    },

    // 여러 키를 한 번에 — 사람이 많아도 요청 1번당 쿼리 수 한도(무료 50개)를 넘지 않게. KV 에는 없는 함수
    async deleteMany(keys) {
      if (!keys.length) return;
      await ensureSchema(db);
      await db.batch(pack(keys, 1).map((part) =>
        db.prepare('DELETE FROM app_data WHERE key IN (' + marks(part.length, '?') + ')').bind(...part)));
    },

    async list(opts) {
      await ensureSchema(db);
      const prefix = (opts && opts.prefix) || '';
      const { results } = await db.prepare('SELECT key FROM app_data WHERE substr(key, 1, ?) = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key')
        .bind(prefix.length, prefix, nowSec()).all();
      return { keys: results.map((r) => ({ name: r.key })), list_complete: true };
    },
  };
}

// ── 캐시 · 변경 이력 ───────────────────────────────────────────
export function createD1Data(db) {
  if (!db) throw new Error('D1 바인딩이 없습니다.');
  return {
    async getCache() {
      await ensureSchema(db);
      const { results } = await db.prepare('SELECT zone_id, data FROM zone_state').all();
      const out = {};
      for (const r of results) out[r.zone_id] = JSON.parse(r.data);
      return out;
    },

    // 기존 항목에 덮어쓰지 않고 합친다 (상태와 설정을 따로 읽으므로 한쪽을 쓸 때 다른 쪽이 지워지면 안 된다)
    async putCacheEntries(entries) {
      const ids = Object.keys(entries);
      if (!ids.length) return;
      await ensureSchema(db);
      const cur = {};
      for (const part of pack(ids, 1)) {
        const { results } = await db.prepare('SELECT zone_id, data FROM zone_state WHERE zone_id IN (' + marks(part.length, '?') + ')')
          .bind(...part).all();
        for (const r of results) cur[r.zone_id] = JSON.parse(r.data);
      }
      const at = Date.now();
      const rows = ids.map((id) => [id, JSON.stringify(Object.assign({}, cur[id], entries[id])), at]);
      await db.batch(pack(rows, 3, (r) => r[1].length).map((part) =>
        db.prepare('INSERT INTO zone_state (zone_id, data, updated_at) VALUES ' + marks(part.length, '(?, ?, ?)') +
          ' ON CONFLICT(zone_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').bind(...part.flat())));
    },

    async appendLog(entries) {
      if (!entries.length) return;
      await ensureSchema(db);
      const rows = entries.map((e) => [String(e.id || ''), String(e.ts || ''), String(e.action || ''), JSON.stringify(e)]);
      await db.batch(pack(rows, 4, (r) => r[3].length).map((part) =>
        db.prepare('INSERT INTO change_log (id, ts, action, data) VALUES ' + marks(part.length, '(?, ?, ?, ?)')).bind(...part.flat())));
    },

    // 최근 limit 건 — 새 것부터
    async readLog(limit) {
      await ensureSchema(db);
      const { results } = await db.prepare('SELECT data FROM change_log ORDER BY seq DESC LIMIT ?').bind(Math.max(0, Math.floor(limit) || 0)).all();
      return results.map((r) => JSON.parse(r.data));
    },

    // id 로 한 건을 찾아 고친다 (되돌리기 표시 등)
    async patchLog(id, patch) {
      await ensureSchema(db);
      const row = await db.prepare('SELECT seq, data FROM change_log WHERE id = ? ORDER BY seq DESC LIMIT 1').bind(id).first();
      if (!row) return false;
      await db.prepare('UPDATE change_log SET data = ? WHERE seq = ?')
        .bind(JSON.stringify(Object.assign(JSON.parse(row.data), patch)), row.seq).run();
      return true;
    },
  };
}
