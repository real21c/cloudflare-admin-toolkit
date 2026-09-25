// 파일 기반 저장소 (로컬 실행용)
//
// 나중에 Workers로 올릴 때는 이 파일만 KV 버전으로 갈아끼우면 된다.
// 인터페이스: get(key) / put(key, value) / keys(prefix)
//
// 저장 위치: data/<key>.json

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'data');

// 키에 경로 문자가 섞여 들어오는 걸 막는다
function safeName(key) {
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) throw new Error('잘못된 키: ' + key);
  return key.replace(/:/g, '__') + '.json';
}

async function ensureDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

export function createStore() {
  // 쓰기 직렬화용 큐. 같은 키에 동시 쓰기가 겹쳐 유실되는 걸 막는다.
  const locks = new Map();

  function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(key, next.catch(() => {}));
    return next;
  }

  return {
    async get(key, fallback) {
      try {
        const raw = await readFile(join(DATA_DIR, safeName(key)), 'utf8');
        return JSON.parse(raw);
      } catch (e) {
        if (e.code === 'ENOENT') return fallback === undefined ? null : fallback;
        throw e;
      }
    },

    async put(key, value) {
      await ensureDir();
      return withLock(key, async () => {
        const path = join(DATA_DIR, safeName(key));
        const tmp = path + '.tmp';
        await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
        // 원자적 교체 — 쓰다 중단돼도 기존 파일이 깨지지 않는다
        const { rename } = await import('node:fs/promises');
        await rename(tmp, path);
        return value;
      });
    },

    // 읽고 → 고치고 → 쓰기 를 한 번에 잠근다 (로그 append 용)
    async update(key, fallback, mutate) {
      await ensureDir();
      return withLock(key, async () => {
        const path = join(DATA_DIR, safeName(key));
        let current;
        try {
          current = JSON.parse(await readFile(path, 'utf8'));
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
          current = fallback;
        }
        const next = mutate(current);
        const tmp = path + '.tmp';
        await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
        const { rename } = await import('node:fs/promises');
        await rename(tmp, path);
        return next;
      });
    },

    async keys(prefix) {
      await ensureDir();
      const files = await readdir(DATA_DIR);
      return files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5).replace(/__/g, ':'))
        .filter((k) => (prefix ? k.startsWith(prefix) : true))
        .sort();
    },
  };
}
