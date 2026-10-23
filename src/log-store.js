// 로컬 실행(파일 저장소)용 캐시 · 변경 이력 (Workers 는 store-d1.js 의 createD1Data)
//
// 변경 이력 저장 — 달마다 1,000건씩 조각으로 나눠 담는다 (log:YYYY-MM:NNN)
//
//   예전에는 달마다 키 하나(log:YYYY-MM)에 다 쌓았다. IP Rule 삭제처럼 건수가 많으면 키 하나가 1MB 를 넘고,
//   쓸 때마다 그 전체를 읽고 다시 쓰느라 Workers 무료 요금제 CPU 한도(요청당 10ms)를 넘어 503 이 났다.
//   지금은 쓸 때 마지막 조각(최대 1,000건)만 읽고 쓴다. 예전 키(log:YYYY-MM)는 그대로 두고 읽기만 한다.
//
//   logp:YYYY-MM   { n, count }   지금 쓰는 조각 번호와 그 조각의 건수 (이 키는 log: 로 시작하지 않아 목록에 안 섞인다)
//
// 키 이름 정렬 = 시간 순서: log:2026-09 < log:2026-09:001 < log:2026-09:002 < log:2026-10 < log:2026-10:001 …

import { monthKey } from './core.js';

export const LOG_CHUNK = 1000;
const chunkKey = (m, n) => 'log:' + m + ':' + String(n).padStart(3, '0');

export async function appendLogEntries(store, entries) {
  if (!entries.length) return;
  const m = monthKey();
  const p = await store.get('logp:' + m, null);
  let n = p && p.n ? p.n : 1;
  let count = p && p.n ? p.count || 0 : 0;
  if (count > 0 && count + entries.length > LOG_CHUNK) { n += 1; count = 0; }
  const next = await store.update(chunkKey(m, n), [], (cur) => (cur || []).concat(entries));
  await store.put('logp:' + m, { n, count: next.length });
}

// 최근 limit 건 — 새 것부터. 최신 조각부터 거꾸로 읽다가 limit 이 차면 멈춘다
export async function readLogEntries(store, limit) {
  const keys = (await store.keys('log:')).sort().reverse();
  let out = [];
  for (const k of keys) {
    out = ((await store.get(k, [])) || []).concat(out);
    if (out.length >= limit) break;
  }
  return out.slice(-limit).reverse();
}

// id 로 한 건을 찾아 고친다 (되돌리기 표시 등). 최신 조각부터 찾는다
export async function patchLogEntry(store, id, patch) {
  const keys = (await store.keys('log:')).sort().reverse();
  for (const k of keys) {
    const rows = (await store.get(k, [])) || [];
    if (rows.some((r) => r.id === id)) {
      await store.update(k, [], (cur) => cur.map((r) => (r.id === id ? Object.assign({}, r, patch) : r)));
      return true;
    }
  }
  return false;
}

// 캐시(키 하나) + 변경 이력(조각) — createD1Data 와 같은 모양
export function createStoreData(store) {
  return {
    getCache: () => store.get('cache', {}).then((v) => v || {}),
    // 기존 항목에 덮어쓰지 않고 합친다.
    // 상태(SSL·프록시)와 설정(캐시규칙·Tiered·Smart)을 따로 읽으므로, 한쪽을 쓸 때 다른 쪽이 지워지면 안 된다.
    putCacheEntries: (entries) =>
      store.update('cache', {}, (cur) => {
        for (const [zoneId, val] of Object.entries(entries)) cur[zoneId] = Object.assign({}, cur[zoneId], val);
        return cur;
      }),
    appendLog: (entries) => appendLogEntries(store, entries),
    readLog: (limit) => readLogEntries(store, limit),
    patchLog: (id, patch) => patchLogEntry(store, id, patch),
  };
}
