// API 로직 — 로컬(server.mjs)과 Workers(worker.js) 가 공유한다.
// 런타임에 의존하는 것은 store 와 config 뿐이고, 둘 다 주입받는다.

import {
  createClient, pool, resolveScope, proxySummary, shortName,
  proxyWarning, collectIps, recordOrder, SSL_LABEL, nowStamp, monthKey, CACHE_RULE_DESC, CACHE_RULE_EXPR,
} from './core.js';
import { createIpApi } from './ip-api.js';
import { FIELDS, SECTIONS, loadSettings, applySettings, pickDefaults, validateField, fieldLabel, isField } from './settings.js';
import { VERSION } from './version.js';

const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function createApi({ store, config }) {
  const cf = config.token ? createClient(config.token) : null;

  // ── 캐시 ────────────────────────────────────────────────
  const getCache = () => store.get('cache', {}).then((v) => v || {});

  // 기존 항목에 덮어쓰지 않고 합친다.
  // 상태(SSL·프록시)와 설정(캐시규칙·Tiered·Smart)을 따로 읽으므로, 한쪽을 쓸 때 다른 쪽이 지워지면 안 된다.
  const putCacheEntries = (entries) =>
    store.update('cache', {}, (cur) => {
      for (const [zoneId, val] of Object.entries(entries)) cur[zoneId] = Object.assign({}, cur[zoneId], val);
      return cur;
    });

  const isFresh = (e) =>
    !!(e && e.at) && Date.now() - e.at < config.cacheTtlMinutes * 60 * 1000;

  // 설정(캐시규칙·Tiered·Smart)은 거의 안 바뀌므로 하루에 한 번만 다시 읽는다.
  // 도구로 바꾸면 그 자리에서 캐시에 반영된다.
  const CFG_TTL = 24 * 60 * 60 * 1000;
  // cfgAt 이 없던 예전 항목은 설정값을 함께 읽었던 시각(at)을 쓴다
  const cfgAtOf = (c) => (c ? c.cfgAt || (c.smart !== undefined ? c.at : 0) : 0);
  const isCfgFresh = (c) => Date.now() - cfgAtOf(c) < CFG_TTL;

  // 상태 — SSL·프록시 (zone 당 2회 호출)
  async function fetchZoneState(zoneId) {
    const [ssl, records] = await Promise.all([cf.getZoneSsl(zoneId), cf.listRecords(zoneId)]);
    return {
      ssl: ssl.ssl,
      autoMode: ssl.autoMode,
      alwaysHttps: ssl.alwaysHttps,
      records,
      summary: proxySummary(records),
      at: Date.now(),
    };
  }

  // 설정 — 캐시규칙·Tiered·Smart (zone 당 3회 호출)
  async function fetchZoneConfig(zoneId) {
    const [rules, tiered, smart] = await Promise.all([
      cf.getCacheRules(zoneId).catch(() => null), // 권한 없으면 null
      cf.getTieredCache(zoneId),
      cf.getSmartTopology(zoneId),
    ]);
    return {
      // null = 확인 못함, true/false = 규칙 유무
      cacheRule: rules === null ? null : rules.some((r) => r.description === CACHE_RULE_DESC),
      tiered: tiered,
      smart: smart,
      cfgAt: Date.now(),
    };
  }

  // ── 로그 ────────────────────────────────────────────────
  async function appendLog(entries) {
    if (!entries.length) return;
    // 누가 바꿨는지 — Workers 에서 OTP 로 로그인했으면 그 이름 (로컬·비밀번호만이면 없음)
    if (config.actor) for (const e of entries) e.by = config.actor;
    await store.update('log:' + monthKey(), [], (cur) => cur.concat(entries));
  }

  async function readLog(limit) {
    const keys = (await store.keys('log:')).sort().reverse();
    let out = [];
    for (const k of keys) {
      out = ((await store.get(k, [])) || []).concat(out);
      if (out.length >= limit) break;
    }
    return out.slice(-limit).reverse();
  }

  async function markReverted(entryId) {
    for (const k of await store.keys('log:')) {
      const rows = (await store.get(k, [])) || [];
      if (rows.some((r) => r.id === entryId)) {
        await store.update(k, [], (cur) =>
          cur.map((r) => (r.id === entryId ? Object.assign({}, r, { reverted: true }) : r))
        );
        return true;
      }
    }
    return false;
  }

  function scopeLabel(mode, ip) {
    if (mode === 'ip') return ip;
    if (mode === 'all') return '모든 레코드';
    return '선택한 레코드';
  }

  // ── 변경 실행 (preview=true 면 아무것도 바꾸지 않음) ─────
  // 정적파일 캐시 규칙 적용/제거
  async function runCacheRule({ zones, value, preview }) {
    const result = [];
    const logEntries = [];

    const outs = await pool(
      zones,
      async (z) => {
        const cur = await cf.getCacheRules(z.id);
        const has = cur.some((r) => r.description === CACHE_RULE_DESC);
        if (has === value) return { zone: z, has, changed: false, others: cur.length - (has ? 1 : 0) };
        if (preview) return { zone: z, has, changed: true, others: cur.length - (has ? 1 : 0) };
        await cf.setCacheRule(z.id, value);
        return { zone: z, has, changed: true, others: cur.length - (has ? 1 : 0), applied: true };
      },
      config.concurrency
    );

    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      const o = outs[i];
      if (!o.ok) {
        result.push({ zone: z.name, zoneId: z.id, kind: 'cache', targets: [], skipped: [],
                      error: String(o.error.message || o.error) });
        continue;
      }
      const v = o.value;
      const label = value ? '적용' : '제거';
      if (!v.changed) {
        result.push({
          zone: z.name, zoneId: z.id, kind: 'cache', targets: [],
          skipped: [{ name: '정적파일 캐시 규칙', reason: value ? '이미 적용됨' : '규칙이 없음' }],
        });
        continue;
      }
      result.push({
        zone: z.name, zoneId: z.id, kind: 'cache',
        targets: [{ name: '정적파일 캐시 규칙', before: v.has ? '있음' : '없음', after: value ? '있음' : '없음' }],
        skipped: v.others ? [{ name: '기존 다른 규칙 ' + v.others + '개', reason: '건드리지 않음' }] : [],
        applied: !!v.applied,
      });
      if (!preview) {
        logEntries.push({
          id: rid(), ts: nowStamp(), zone: z.name, zoneId: z.id, action: 'cache',
          label: '정적파일 캐시 규칙 ' + label + ' (CF엣지서버 30일 / 방문자 브라우저 1일)',
          cacheBefore: v.has, cacheAfter: value, reverted: false,
        });
      }
    }

    if (!preview) {
      await appendLog(logEntries);
      // 목록 뱃지가 바로 바뀌도록 캐시에도 반영
      const upd = {};
      const cache = await getCache();
      for (let i = 0; i < zones.length; i++) {
        if (!outs[i].ok || !outs[i].value.changed) continue;
        const c = cache[zones[i].id];
        if (c) upd[zones[i].id] = Object.assign({}, c, { cacheRule: value });
      }
      if (Object.keys(upd).length) await putCacheEntries(upd);
    }
    return { result, logged: logEntries.length };
  }

  // Tiered Cache 켜기/끄기
  async function runTiered({ zones, value, preview }) {
    const result = [];
    const logEntries = [];

    const outs = await pool(
      zones,
      async (z) => {
        const cur = await cf.getTieredCache(z.id);
        if (cur === value) return { has: cur, changed: false };
        if (preview) return { has: cur, changed: true };
        await cf.setTieredCache(z.id, value);
        return { has: cur, changed: true, applied: true };
      },
      config.concurrency
    );

    const upd = {};
    const cache = await getCache();

    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      const o = outs[i];
      if (!o.ok) {
        result.push({ zone: z.name, zoneId: z.id, kind: 'tiered', targets: [], skipped: [],
                      error: String(o.error.message || o.error) });
        continue;
      }
      const v = o.value;
      if (!v.changed) {
        result.push({
          zone: z.name, zoneId: z.id, kind: 'tiered', targets: [],
          skipped: [{ name: 'Tiered Cache', reason: '이미 ' + (value ? 'ON' : 'OFF') }],
        });
        continue;
      }
      result.push({
        zone: z.name, zoneId: z.id, kind: 'tiered',
        targets: [{ name: 'Tiered Cache', before: v.has === null ? '알 수 없음' : (v.has ? 'ON' : 'OFF'),
                    after: value ? 'ON' : 'OFF' }],
        skipped: [], applied: !!v.applied,
      });
      if (!preview) {
        logEntries.push({
          id: rid(), ts: nowStamp(), zone: z.name, zoneId: z.id, action: 'tiered',
          label: 'Tiered Cache ' + (value ? 'ON' : 'OFF'),
          tieredBefore: v.has, tieredAfter: value, reverted: false,
        });
        const c = cache[z.id];
        if (c) upd[z.id] = Object.assign({}, c, { tiered: value });
      }
    }

    if (!preview) {
      await appendLog(logEntries);
      if (Object.keys(upd).length) await putCacheEntries(upd);
    }
    return { result, logged: logEntries.length };
  }

  async function runSmart({ zones, value, preview }) {
    const result = [];
    const logEntries = [];

    const outs = await pool(
      zones,
      async (z) => {
        const [curSmart, curTier] = await Promise.all([cf.getSmartTopology(z.id), cf.getTieredCache(z.id)]);
        const needTier = value && curTier !== true;
        if (curSmart === value && !needTier) return { has: curSmart, changed: false };
        if (preview) return { has: curSmart, changed: true, needTier };
        if (needTier) await cf.setTieredCache(z.id, true);
        await cf.setSmartTopology(z.id, value);
        return { has: curSmart, changed: true, needTier, tierBefore: curTier, applied: true };
      },
      config.concurrency
    );

    const upd = {};
    const cache = await getCache();

    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      const o = outs[i];
      if (!o.ok) {
        result.push({ zone: z.name, zoneId: z.id, kind: 'smart', targets: [], skipped: [],
                      error: String(o.error.message || o.error) });
        continue;
      }
      const v = o.value;
      if (!v.changed) {
        result.push({ zone: z.name, zoneId: z.id, kind: 'smart', targets: [],
                      skipped: [{ name: 'Smart Tiered Cache', reason: '이미 ' + (value ? 'ON' : 'OFF') }] });
        continue;
      }
      result.push({
        zone: z.name, zoneId: z.id, kind: 'smart',
        targets: [{ name: 'Smart Tiered Cache', before: v.has === null ? '알 수 없음' : (v.has ? 'ON' : 'OFF'),
                    after: value ? 'ON' : 'OFF' }],
        skipped: [], applied: !!v.applied,
      });
      if (!preview) {
        logEntries.push({
          id: rid(), ts: nowStamp(), zone: z.name, zoneId: z.id, action: 'smart',
          label: 'Smart Tiered Cache ' + (value ? 'ON' : 'OFF') + (v.needTier ? ' (Tiered Cache 스위치도 ON)' : ''),
          smartBefore: v.has, smartAfter: value, tierBefore: v.tierBefore, reverted: false,
        });
        const c = cache[z.id];
        if (c) upd[z.id] = Object.assign({}, c, { smart: value }, v.needTier ? { tiered: true } : {});
      }
    }

    if (!preview) {
      await appendLog(logEntries);
      if (Object.keys(upd).length) await putCacheEntries(upd);
    }
    return { result, logged: logEntries.length };
  }

  async function runChange({ zones, action, value, manual, preview }) {
    if (action === 'smart') return runSmart({ zones, value, preview });
    if (action === 'cache') return runCacheRule({ zones, value, preview });
    if (action === 'tiered') return runTiered({ zones, value, preview });
    // 대상 IP 는 설정값으로 고정한다. 이 IP 가 아닌 레코드는 어떤 경우에도 안 바뀐다.
    const ip = config.serverIp;
    const mode = 'ip';

    const plans = await pool(
      zones,
      async (z) => {
        const state = await fetchZoneState(z.id); // 실행 직전 항상 재확인
        const scope = action === 'proxy'
          ? resolveScope(z.name, state.records, mode, value, (manual || {})[z.id], ip)
          : null;
        return { zone: z, state, scope };
      },
      config.concurrency
    );

    const result = [];
    const logEntries = [];
    const cacheUpdates = {};

    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      const z = zones[i];

      if (!p.ok) {
        result.push({
          zone: z.name, zoneId: z.id,
          error: String(p.error.message || p.error), targets: [], skipped: [],
        });
        continue;
      }

      const { state, scope } = p.value;

      // ── SSL ──
      if (action === 'ssl') {
        const before = state.ssl;
        if (before === value) {
          result.push({
            zone: z.name, zoneId: z.id, kind: 'ssl', targets: [],
            skipped: [{ name: '(zone)', reason: '이미 ' + (SSL_LABEL[value] || value) }],
          });
          cacheUpdates[z.id] = state;
          continue;
        }

        const item = {
          zone: z.name, zoneId: z.id, kind: 'ssl',
          targets: [{
            name: '(zone)',
            before: SSL_LABEL[before] || before,
            after: SSL_LABEL[value] || value,
          }],
          skipped: [], autoMode: state.autoMode,
        };

        if (!preview) {
          try {
            const r = await cf.setSsl(z.id, value, state.autoMode);
            item.applied = true;
            item.switchedToCustom = r.switchedToCustom;
            state.ssl = r.ssl;
            state.autoMode = 'custom';
            logEntries.push({
              id: rid(), ts: nowStamp(), zone: z.name, zoneId: z.id, action: 'ssl',
              label: 'SSL ' + (SSL_LABEL[before] || before) + ' → ' + (SSL_LABEL[value] || value),
              sslBefore: before, sslAfter: r.ssl, reverted: false,
            });
          } catch (e) {
            item.error = String(e.message || e);
          }
        }
        cacheUpdates[z.id] = state;
        result.push(item);
        continue;
      }

      // ── 프록시 ──
      const item = {
        zone: z.name, zoneId: z.id, kind: 'proxy',
        targets: scope.targets.slice().sort((a, b) => recordOrder(a, b, z.name)).map((r) => ({
          id: r.id, name: shortName(r.name, z.name), type: r.type, content: r.content,
          before: r.proxied, after: value,
          warn: value ? proxyWarning(r, z.name, state.records) : null,
        })),
        skipped: scope.skipped.map((s) => ({
          name: shortName(s.record.name, z.name), type: s.record.type,
          content: s.record.content, proxiable: s.record.proxiable,
          before: s.record.proxied, reason: s.reason,
        })),
      };

      if (!preview && scope.targets.length) {
        const outs = await pool(
          scope.targets,
          (r) => cf.setProxied(z.id, r.id, value),
          config.concurrency
        );
        const changes = scope.targets.map((r, k) => ({
          recordId: r.id, name: shortName(r.name, z.name), type: r.type,
          before: r.proxied, after: value,
          ok: outs[k].ok,
          error: outs[k].ok ? null : String(outs[k].error.message || outs[k].error),
        }));
        for (let k = 0; k < changes.length; k++) {
          if (!changes[k].ok) continue;
          const hit = state.records.find((x) => x.id === changes[k].recordId);
          if (hit) hit.proxied = value;
        }
        item.results = changes;
        item.failed = changes.filter((c) => !c.ok).length;
        state.summary = proxySummary(state.records);

        const okOnes = changes.filter((c) => c.ok);
        if (okOnes.length) {
          logEntries.push({
            id: rid(), ts: nowStamp(), zone: z.name, zoneId: z.id, action: 'proxy',
            label: scopeLabel(mode, ip) + ' ' + (value ? 'proxy' : 'DNS only') +
                   '로 변경 (' + okOnes.length + '건)',
            changes: okOnes, reverted: false,
          });
        }
        const failed = changes.filter((c) => !c.ok);
        if (failed.length) {
          logEntries.push({
            id: rid(), ts: nowStamp(), zone: z.name, zoneId: z.id, action: 'proxy-fail',
            label: '실패 ' + failed.length + '건 — ' +
                   failed.map((f) => f.name + ' (' + f.error + ')').join(', '),
            reverted: false,
          });
        }
      }

      cacheUpdates[z.id] = state;
      result.push(item);
    }

    if (!preview) await appendLog(logEntries);
    if (Object.keys(cacheUpdates).length) await putCacheEntries(cacheUpdates);

    return { result, logged: logEntries.length };
  }

  // ── 라우팅 ──────────────────────────────────────────────
  // 반환: { status, body }
  return async function handle(method, path, query, body) {
    // IP 룰 모듈 — 토큰(config.ipToken)이 따로라서 도메인 토큰이 없어도 동작한다. 변경은 같은 변경 이력에 남긴다.
    // 요청마다 새로 만든다 (로컬 서버는 요청이 겹칠 수 있어서 호출 수 calls 가 섞이지 않게)
    if (path.startsWith('/api/ip/')) return createIpApi({ store, config, log: appendLog })(method, path, query, body || {});

    // 설정 메뉴 — 토큰 없이도 동작. 바꾸는 건 관리자만 (config.canAdmin — Workers 는 OTP 관리자, 로컬은 누구나)
    if (path === '/api/settings') {
      const defaults = config.defaults || pickDefaults(config);
      const state = async (saved) => {
        const groups = await store.get('groups', { order: [], map: {} });
        return {
          version: VERSION, sections: SECTIONS, fields: FIELDS, defaults, saved, values: pickDefaults(applySettings(defaults, saved)),
          canEdit: !!config.canAdmin, groups: (groups && groups.order) || [],
        };
      };
      if (method === 'GET') return { status: 200, body: await state(await loadSettings(store)) };
      if (method === 'PUT') {
        if (!config.canAdmin) return { status: 403, body: { error: '설정은 관리자만 바꿀 수 있습니다.' } };
        const changes = body && body.changes;
        if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return { status: 400, body: { error: 'changes 가 없습니다.' } };
        const saved = await loadSettings(store);
        const next = Object.assign({}, saved);
        const entries = [];
        const shown = (v) => (v === '' || v == null ? '(없음)' : v);
        const keys = Object.keys(changes);
        if (keys.length > FIELDS.length) return { status: 400, body: { error: '항목이 너무 많습니다.' } };
        for (const k of keys) if (!isField(k)) return { status: 400, body: { error: '알 수 없는 항목: ' + k } };
        for (const k of keys) {
          const v = changes[k];
          let val;
          try { val = v === null ? null : validateField(k, v); } catch (e) { return { status: 400, body: { error: e.message } }; }
          const before = saved[k] !== undefined ? saved[k] : defaults[k];
          // 기본값과 같은 값이면 바꾼 값으로 두지 않는다 (= 기본값으로)
          const toDefault = val === null || String(val) === String(defaults[k]);
          if (toDefault) delete next[k]; else next[k] = val;
          const after = toDefault ? defaults[k] : val;
          if (String(before) === String(after)) continue; // 실제 값이 그대로면 기록하지 않는다
          entries.push({
            id: rid(), ts: nowStamp(), zone: '설정', zoneId: '', action: 'settings',
            label: fieldLabel(k) + ': ' + shown(before) + ' → ' + shown(after) + (toDefault ? ' (기본값으로)' : ''),
          });
        }
        await store.put('settings', next);
        // 이력 쓰기가 실패해도 설정은 이미 저장됐다 — 화면에 알린다
        let logError = '';
        if (entries.length) { try { await appendLog(entries); } catch (e) { logError = '변경 이력 기록 실패: ' + e.message; } }
        return { status: 200, body: Object.assign(await state(next), { changed: entries.length }, logError ? { logError } : {}) };
      }
    }

    if (!cf) {
      return {
        status: 503,
        body: { error: 'NO_TOKEN', message: 'Cloudflare API 토큰이 설정되지 않았습니다.' },
      };
    }

    if (path === '/api/verify' && method === 'GET') {
      const info = await cf.verify();
      return { status: 200, body: { ok: true, status: info.status, expiresOn: info.expires_on || null } };
    }

    if (path === '/api/zones' && method === 'GET') {
      const [zones, cache, groups] = await Promise.all([
        cf.listZones(),
        getCache(),
        store.get('groups', { order: [], map: {} }),
      ]);

      const rows = zones.map((z) => {
        const c = cache[z.id];
        const ipCounts = {};
        let proxyable = 0;
        let onCount = 0;
        for (const r of (c && c.records) || []) {
          if (['A', 'AAAA', 'CNAME'].indexOf(r.type) === -1 || !r.proxiable) continue;
          ipCounts[r.content] = (ipCounts[r.content] || 0) + 1;
          proxyable++;
          if (r.content === config.serverIp && r.proxied) onCount++;
        }
        return Object.assign({}, z, {
          group: groups.map[z.name] || null,
          ssl: c ? c.ssl : null,
          autoMode: c ? c.autoMode : null,
          summary: c ? c.summary : null,
          cachedAt: c ? c.at : null,
          stale: !isFresh(c),
          cfgStale: !isCfgFresh(c),
          cacheRule: c ? (c.cacheRule === undefined ? null : c.cacheRule) : null,
          tiered: c ? (c.tiered === undefined ? null : c.tiered) : null,
          smart: c ? (c.smart === undefined ? null : c.smart) : null,
          ipCounts, proxyable, onCount,
        });
      });

      const live = new Set(zones.map((z) => z.name));
      return {
        status: 200,
        body: {
          zones: rows,
          groups,
          orphans: Object.keys(groups.map).filter((n) => !live.has(n)),
          total: zones.length,
          ips: collectIps(cache),
          serverIp: config.serverIp,
          defaultGroup: config.defaultGroup,
          // 한 번에 처리할 zone 수 상한 (Workers 무료는 요청당 subrequest 50개 제한)
          maxZonesPerCall: config.maxZonesPerCall,
          cacheRuleExpr: CACHE_RULE_EXPR,
        },
      };
    }

    if (path === '/api/status' && method === 'POST') {
      const ids = body.zoneIds || [];
      const force = !!body.force;
      const cache = await getCache();
      const need = force ? ids : ids.filter((id) => !isFresh(cache[id]));

      const updates = {};
      if (need.length) {
        const outs = await pool(need, (id) => fetchZoneState(id), config.concurrency);
        for (let i = 0; i < need.length; i++) if (outs[i].ok) updates[need[i]] = outs[i].value;
        if (Object.keys(updates).length) await putCacheEntries(updates);
      }

      const out = {};
      for (const id of ids) {
        const c = Object.assign({}, cache[id], updates[id]); // 설정값이 지워지지 않게 항목 단위로 합친다
        if (c.at) out[id] = { ssl: c.ssl, autoMode: c.autoMode, summary: c.summary, cacheRule: c.cacheRule, tiered: c.tiered, smart: c.smart, at: c.at };
      }
      return { status: 200, body: { status: out, fetched: need.length } };
    }

    // 설정(캐시규칙·Tiered·Smart) 조회 — 하루 지난 것만, force 면 전부
    if (path === '/api/config' && method === 'POST') {
      const ids = body.zoneIds || [];
      const force = !!body.force;
      const cache = await getCache();
      const need = force ? ids : ids.filter((id) => !isCfgFresh(cache[id]));

      const updates = {};
      if (need.length) {
        const outs = await pool(need, (id) => fetchZoneConfig(id), config.concurrency);
        for (let i = 0; i < need.length; i++) if (outs[i].ok) updates[need[i]] = outs[i].value;
        if (Object.keys(updates).length) await putCacheEntries(updates);
      }

      const out = {};
      for (const id of ids) {
        const c = Object.assign({}, cache[id], updates[id]);
        out[id] = { cacheRule: c.cacheRule, tiered: c.tiered, smart: c.smart, cfgStale: !isCfgFresh(c) };
      }
      return { status: 200, body: { config: out, fetched: need.length } };
    }

    if (path === '/api/records' && method === 'POST') {
      const state = await fetchZoneState(body.zoneId);
      await putCacheEntries({ [body.zoneId]: state });
      return {
        status: 200,
        body: { records: state.records, ssl: state.ssl, autoMode: state.autoMode, summary: state.summary },
      };
    }

    if ((path === '/api/preview' || path === '/api/apply') && method === 'POST') {
      const out = await runChange({
        zones: body.zones, action: body.action, value: body.value,
        manual: body.manual, preview: path === '/api/preview',
      });
      return { status: 200, body: out };
    }

    if (path === '/api/groups' && method === 'GET') {
      return { status: 200, body: await store.get('groups', { order: [], map: {} }) };
    }
    if (path === '/api/groups' && method === 'POST') {
      const saved = await store.put('groups', { order: body.order || [], map: body.map || {} });
      return { status: 200, body: saved };
    }

    if (path === '/api/log' && method === 'GET') {
      const limit = Number(query.get('limit') || 200);
      return { status: 200, body: { entries: await readLog(limit) } };
    }

    if (path === '/api/revert' && method === 'POST') {
      const entries = await readLog(1000);
      const entry = entries.find((e) => e.id === body.id);
      if (!entry) return { status: 404, body: { error: '이력을 찾을 수 없습니다' } };
      if (entry.reverted) return { status: 400, body: { error: '이미 되돌린 항목입니다' } };

      const out = { zone: entry.zone, results: [] };

      if (entry.action === 'ssl') {
        try {
          const state = await fetchZoneState(entry.zoneId);
          const r = await cf.setSsl(entry.zoneId, entry.sslBefore, state.autoMode);
          out.results.push({ name: '(zone)', ok: true, value: r.ssl });
          state.ssl = r.ssl;
          await putCacheEntries({ [entry.zoneId]: state });
        } catch (e) {
          out.results.push({ name: '(zone)', ok: false, error: String(e.message || e) });
        }
      } else if (entry.action === 'proxy') {
        const outs = await pool(
          entry.changes,
          (c) => cf.setProxied(entry.zoneId, c.recordId, c.before),
          config.concurrency
        );
        entry.changes.forEach((c, i) => {
          out.results.push({
            name: c.name, ok: outs[i].ok,
            error: outs[i].ok ? null : String(outs[i].error.message || outs[i].error),
          });
        });
        await putCacheEntries({ [entry.zoneId]: await fetchZoneState(entry.zoneId) });
      } else if (entry.action === 'smart') {
        try {
          await cf.setSmartTopology(entry.zoneId, !!entry.smartBefore);
          if (entry.tierBefore === false) await cf.setTieredCache(entry.zoneId, false);
          out.results.push({ name: 'Smart Tiered Cache', ok: true });
        } catch (e) {
          out.results.push({ name: 'Smart Tiered Cache', ok: false, error: String(e.message || e) });
        }
      } else if (entry.action === 'tiered') {
        try {
          await cf.setTieredCache(entry.zoneId, !!entry.tieredBefore);
          out.results.push({ name: 'Tiered Cache', ok: true });
        } catch (e) {
          out.results.push({ name: 'Tiered Cache', ok: false, error: String(e.message || e) });
        }
      } else if (entry.action === 'cache') {
        try {
          await cf.setCacheRule(entry.zoneId, entry.cacheBefore);
          out.results.push({ name: '정적파일 캐시 규칙', ok: true });
        } catch (e) {
          out.results.push({ name: '정적파일 캐시 규칙', ok: false, error: String(e.message || e) });
        }
      } else {
        return { status: 400, body: { error: '되돌릴 수 없는 항목입니다' } };
      }

      await markReverted(entry.id);
      await appendLog([{
        id: rid(), ts: nowStamp(), zone: entry.zone, zoneId: entry.zoneId, action: 'revert',
        label: '되돌리기 — ' + entry.label + ' (' + out.results.filter((r) => r.ok).length + '건)',
        reverted: false,
      }]);

      return { status: 200, body: out };
    }

    return { status: 404, body: { error: 'Not found' } };
  };
}
