// KV 기반 저장소 (Workers 용)
//
// store-file.js 와 같은 인터페이스를 제공한다: get / put / update / keys
// 로컬은 파일, Workers 는 KV — 나머지 코드는 어느 쪽인지 몰라도 된다.
//
// 주의: KV 는 append 가 없어서 update 는 읽기→수정→쓰기다.
// 동시 쓰기가 겹치면 유실될 수 있으므로, 호출하는 쪽에서
// "작업 단위로 한 번만" 쓰도록 모아서 보낸다.

export function createStore(kv) {
  if (!kv) throw new Error('KV 바인딩이 없습니다.');

  return {
    async get(key, fallback) {
      const v = await kv.get(key, 'json');
      if (v === null || v === undefined) return fallback === undefined ? null : fallback;
      return v;
    },

    async put(key, value) {
      await kv.put(key, JSON.stringify(value));
      return value;
    },

    async update(key, fallback, mutate) {
      const cur = await kv.get(key, 'json');
      const next = mutate(cur === null || cur === undefined ? fallback : cur);
      await kv.put(key, JSON.stringify(next));
      return next;
    },

    async keys(prefix) {
      const out = [];
      let cursor;
      for (;;) {
        const res = await kv.list(prefix ? { prefix, cursor } : { cursor });
        for (const k of res.keys) out.push(k.name);
        if (res.list_complete) break;
        cursor = res.cursor;
      }
      return out.sort();
    },
  };
}
