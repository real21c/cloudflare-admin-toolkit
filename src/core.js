// Cloudflare API 공용 로직
// 로컬 Node(server.mjs)와 나중의 Workers 양쪽에서 그대로 쓴다.
// 여기에는 fetch 외의 런타임 의존성을 넣지 않는다.

const API = 'https://api.cloudflare.com/client/v4';

// ─────────────────────────────────────────────────────────────
// 보호 목록: 프록시를 켜면 서비스가 죽는 서브도메인들
//   mail/smtp/imap/pop : 프록시하면 메일 수발신 중단
//   ftp/sftp/ssh/vpn   : CF 프록시는 HTTP(S) 포트만 통과시킴
//   ns/ns1/ns2         : 네임서버
//   autodiscover 등    : 메일 클라이언트 자동설정
// ─────────────────────────────────────────────────────────────
export const PROTECTED_PREFIXES = [
  'mail', 'mail1', 'mail2', 'smtp', 'smtp1', 'smtp2', 'imap', 'pop', 'pop3',
  'mx', 'mx1', 'mx2', 'webmail', 'mailer', 'relay', 'newsletter',
  'autodiscover', 'autoconfig',
  'ftp', 'sftp', 'ssh', 'vpn', 'sip', 'rdp',
  'ns', 'ns1', 'ns2', 'ns3', 'dns', 'dns1', 'dns2',
  'cpanel', 'whm', 'webdisk', 'direct', 'origin', 'db', 'mysql',
];

// CF에서 프록시가 가능한 레코드 타입은 이 셋뿐이다.
export const PROXYABLE_TYPES = ['A', 'AAAA', 'CNAME'];

export const SSL_MODES = ['off', 'flexible', 'full', 'strict'];
export const SSL_LABEL = {
  off: 'Off',
  flexible: 'Flexible',
  full: 'Full',
  strict: 'Full (strict)',
  origin_pull: 'Origin Pull',
};

// 프록시를 켜면 안 되는 호스트에 대한 경고 문구.
// 걸러내지 않고, 미리보기에 "왜 위험한지"를 그대로 보여준다.
const PROTO_WARN = [
  { names: ['ftp', 'ftps', 'sftp'], msg: 'FTP는 Cloudflare 프록시를 통과하지 못합니다' },
  { names: ['ssh', 'vpn', 'rdp', 'sip'], msg: '이 프로토콜은 Cloudflare 프록시(HTTP/HTTPS)를 통과하지 못합니다' },
  { names: ['smtp', 'imap', 'pop', 'pop3', 'mx', 'mx1', 'mx2'], msg: '메일 프로토콜은 Cloudflare 프록시를 통과하지 못합니다' },
  { names: ['ns', 'ns1', 'ns2', 'ns3', 'dns', 'dns1', 'dns2'], msg: '네임서버는 프록시 대상이 아닙니다' },
];

// 프록시를 켤 때만 의미가 있는 경고를 만든다. 없으면 null.
export function proxyWarning(record, zoneName, allRecords) {
  const mxTarget = allRecords.some(
    (r) => r.type === 'MX' && r.content.replace(/\.$/, '') === record.name
  );
  if (mxTarget) return '이 도메인의 MX가 이 호스트를 가리킵니다 — 프록시하면 메일이 끊깁니다';

  const first = shortName(record.name, zoneName).split('.')[0].toLowerCase();
  for (const w of PROTO_WARN) if (w.names.indexOf(first) !== -1) return w.msg;
  return null;
}


// ─────────────────────────────────────────────────────────────
// 정적파일 캐시 규칙
//   원서버가 Cache-Control: max-age=30 같은 짧은 값을 보내도 무시하고
//   엣지에 30일, 브라우저에 1일 붙들어 둔다.
// ─────────────────────────────────────────────────────────────
// 도구가 이 설명 문자열로 자기 규칙을 찾는다. 규칙을 건 뒤에 바꾸면 예전 규칙을 못 찾고 새로 하나 더 만든다.
export const CACHE_RULE_DESC = 'static-assets (cloudflare-admin-toolkit)';
export const CACHE_RULE_EXPR =
  '(http.request.uri.path.extension in {"css" "js" "jpg" "jpeg" "png" "gif" "webp" "svg" "ico" "woff" "woff2" "ttf"})';

export const CACHE_EDGE_TTL = 2592000; // 30일
export const CACHE_BROWSER_TTL = 86400; // 1일

export function buildCacheRule() {
  return {
    action: 'set_cache_settings',
    description: CACHE_RULE_DESC,
    enabled: true,
    expression: CACHE_RULE_EXPR,
    action_parameters: {
      cache: true,
      edge_ttl: { mode: 'override_origin', default: CACHE_EDGE_TTL },
      browser_ttl: { mode: 'override_origin', default: CACHE_BROWSER_TTL },
    },
  };
}

export class CfError extends Error {
  constructor(message, status, errors) {
    super(message);
    this.name = 'CfError';
    this.status = status;
    this.errors = errors || [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// 동시 실행 풀. CF Rate Limit(1200req/5분)을 넘지 않도록 동시성을 제한한다.
// ─────────────────────────────────────────────────────────────
export async function pool(items, worker, concurrency = 6, onProgress) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;

  async function runner() {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }

  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, runner));
  return results;
}

// ─────────────────────────────────────────────────────────────
export function createClient(token) {
  if (!token) throw new Error('API 토큰이 없습니다. config.json 을 확인하세요.');

  async function call(path, init, attempt) {
    init = init || {};
    attempt = attempt || 0;

    const res = await fetch(API + path, {
      method: init.method || 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });

    // 429(레이트리밋) / 5xx 는 짧게 기다렸다 최대 3회 재시도.
    // CF 가 retry-after 로 몇 분을 달라고 해도 그대로 기다리면 화면이 멈춘 것처럼 보이므로
    // 대기는 5초로 자르고, 그래도 안 되면 실패로 넘긴다.
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Math.min(retryAfter ? retryAfter * 1000 : 500 * Math.pow(2, attempt), 5000);
      await sleep(wait);
      return call(path, init, attempt + 1);
    }

    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw new CfError('응답을 해석할 수 없습니다 (HTTP ' + res.status + ')', res.status);
    }

    if (!res.ok || json.success === false) {
      const errs = json.errors || [];
      const msg = errs.length ? errs.map((e) => e.message).join(', ') : 'HTTP ' + res.status;
      throw new CfError(msg, res.status, errs);
    }
    return json;
  }

  return {
    call,

    // 토큰 유효성 확인
    async verify() {
      return (await call('/user/tokens/verify')).result;
    },

    // 전체 zone 목록. per_page 최대 50이라 페이지를 순회한다.
    // 목록은 캐시하지 않고 매번 조회한다 (도메인 추가/삭제를 놓치지 않기 위해).
    async listZones() {
      const first = await call('/zones?per_page=50&page=1');
      const info = first.result_info || { total_pages: 1, total_count: first.result.length };
      let zones = first.result;

      if (info.total_pages > 1) {
        const pages = [];
        for (let p = 2; p <= info.total_pages; p++) pages.push(p);
        const rest = await pool(pages, (p) => call('/zones?per_page=50&page=' + p), 4);
        for (const r of rest) {
          if (!r.ok) throw r.error;
          zones = zones.concat(r.value.result);
        }
      }
      zones.sort((a, b) => a.name.localeCompare(b.name));
      return zones.map(slimZone);
    },

    // zone 설정을 한 번에 받아 ssl / ssl_automatic_mode 를 뽑는다.
    // 설정별로 따로 부르면 zone당 요청이 2배가 된다.
    async getZoneSsl(zoneId) {
      const json = await call('/zones/' + zoneId + '/settings');
      const find = (id) => {
        const hit = json.result.find((s) => s.id === id);
        return hit ? hit.value : null;
      };
      return {
        ssl: find('ssl'),
        autoMode: find('ssl_automatic_mode'), // 'auto' | 'custom' | null
        alwaysHttps: find('always_use_https'),
      };
    },

    async listRecords(zoneId) {
      const out = [];
      let page = 1;
      for (;;) {
        const json = await call('/zones/' + zoneId + '/dns_records?per_page=100&page=' + page);
        out.push.apply(out, json.result);
        const info = json.result_info;
        if (!info || page >= info.total_pages) break;
        page++;
      }
      const slim = out.map(slimRecord);
      // zone 이름은 레코드 중 가장 짧은 것
      const zone = slim.length ? slim.reduce((a, b) => (b.name.length < a.length ? b.name : a), slim[0].name) : '';
      return slim.sort((a, b) => recordOrder(a, b, zone));
    },

    async setProxied(zoneId, recordId, proxied) {
      const json = await call('/zones/' + zoneId + '/dns_records/' + recordId, {
        method: 'PATCH',
        body: { proxied: proxied },
      });
      return slimRecord(json.result);
    },

    // Tiered Cache 켜짐 여부
    async getTieredCache(zoneId) {
      try {
        const j = await call('/zones/' + zoneId + '/argo/tiered_caching');
        return j.result ? j.result.value === 'on' : null;
      } catch (e) {
        return null; // 권한/플랜에 따라 조회 불가할 수 있다
      }
    },

    async setTieredCache(zoneId, on) {
      const j = await call('/zones/' + zoneId + '/argo/tiered_caching', {
        method: 'PATCH',
        body: { value: on ? 'on' : 'off' },
      });
      return j.result ? j.result.value === 'on' : null;
    },

    // Smart Tiered Cache — 상위 엣지를 원서버와 가까운 곳(서울 ICN)으로 자동 선택
    async getSmartTopology(zoneId) {
      try {
        const j = await call('/zones/' + zoneId + '/cache/tiered_cache_smart_topology_enable');
        return j.result ? j.result.value === 'on' : null;
      } catch (e) {
        return null;
      }
    },

    async setSmartTopology(zoneId, on) {
      const j = await call('/zones/' + zoneId + '/cache/tiered_cache_smart_topology_enable', {
        method: 'PATCH',
        body: { value: on ? 'on' : 'off' },
      });
      return j.result ? j.result.value === 'on' : null;
    },

    // 이 zone 의 캐시 규칙(entrypoint ruleset) 목록
    async getCacheRules(zoneId) {
      try {
        const j = await call('/zones/' + zoneId + '/rulesets/phases/http_request_cache_settings/entrypoint');
        return (j.result && j.result.rules) || [];
      } catch (e) {
        if (e.status === 404) return []; // 아직 규칙이 하나도 없는 zone
        throw e;
      }
    },

    // 우리 규칙만 추가/교체하거나 제거한다. 다른 규칙은 건드리지 않는다.
    async setCacheRule(zoneId, enable) {
      const cur = await this.getCacheRules(zoneId);
      const others = cur.filter((r) => r.description !== CACHE_RULE_DESC);
      const rules = enable ? [buildCacheRule()].concat(others) : others;
      const j = await call('/zones/' + zoneId + '/rulesets/phases/http_request_cache_settings/entrypoint', {
        method: 'PUT',
        body: { rules: rules },
      });
      return (j.result && j.result.rules) || [];
    },

    // SSL 모드 변경.
    // Automatic SSL/TLS가 켜져 있으면(auto) CF가 값을 되돌려버리므로
    // 먼저 custom 으로 전환한 뒤 값을 쓴다.
    async setSsl(zoneId, value, currentAutoMode) {
      let switched = false;
      if (currentAutoMode === 'auto') {
        try {
          await call('/zones/' + zoneId + '/settings/ssl_automatic_mode', {
            method: 'PATCH',
            body: { value: 'custom' },
          });
          switched = true;
        } catch (e) {
          // 플랜에 따라 이 설정이 없을 수 있다. 없으면 그냥 진행.
          if (e.status !== 404 && e.status !== 400) throw e;
        }
      }
      const json = await call('/zones/' + zoneId + '/settings/ssl', {
        method: 'PATCH',
        body: { value: value },
      });
      return { ssl: json.result.value, switchedToCustom: switched };
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 응답에서 필요한 필드만 남긴다 (캐시 용량 + 파싱 비용 절감)
// ─────────────────────────────────────────────────────────────
function slimZone(z) {
  return {
    id: z.id,
    name: z.name,
    status: z.status, // active | pending | initializing | moved | deactivated
    paused: z.paused,
    type: z.type, // full | partial(CNAME setup)
    plan: z.plan ? z.plan.name : null,
    account: z.account ? z.account.name : null,
    accountId: z.account ? z.account.id : null,
    nameServers: z.name_servers || [],
    originalNs: z.original_name_servers || [],
  };
}

function slimRecord(r) {
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    content: r.content,
    proxied: !!r.proxied,
    proxiable: !!r.proxiable,
    ttl: r.ttl,
  };
}

// @ → www → m → 나머지 알파벳 순
const NAME_RANK = { '@': 0, 'www': 1, 'm': 2 };
export function recordOrder(a, b, zoneName) {
  const sa = shortName(a.name, zoneName);
  const sb = shortName(b.name, zoneName);
  const ra = NAME_RANK[sa] != null ? NAME_RANK[sa] : 9;
  const rb = NAME_RANK[sb] != null ? NAME_RANK[sb] : 9;
  if (ra !== rb) return ra - rb;
  return sa.localeCompare(sb) || a.type.localeCompare(b.type);
}

// ─────────────────────────────────────────────────────────────
// 레코드 헬퍼
// ─────────────────────────────────────────────────────────────

// 한글 도메인은 zone 이름이 유니코드(예: 한글.kr)인데
// 레코드 이름은 punycode(xn--….kr)로 온다. 둘 다 맞춰본다.
export function toAscii(host) {
  try { return new URL('http://' + host).hostname; } catch (e) { return host; }
}

// 'www.example.com' → 'www',  'example.com' → '@'
export function shortName(recordName, zoneName) {
  if (!zoneName) return recordName;
  const cands = zoneName === toAscii(zoneName) ? [zoneName] : [zoneName, toAscii(zoneName)];
  for (const z of cands) {
    if (recordName === z) return '@';
    if (recordName.endsWith('.' + z)) return recordName.slice(0, -(z.length + 1));
  }
  return recordName;
}

export function isProtected(recordName, zoneName) {
  const short = shortName(recordName, zoneName);
  if (short === '@') return false;
  const first = short.split('.')[0].toLowerCase();
  return PROTECTED_PREFIXES.indexOf(first) !== -1;
}

// 프록시 상태 요약 → 3-state 버튼용
// state: all(전부 Proxied) | none(전부 DNS only) | mixed(혼합) | empty(대상 없음)
export function proxySummary(records) {
  const cand = records.filter((r) => r.proxiable && PROXYABLE_TYPES.indexOf(r.type) !== -1);
  const on = cand.filter((r) => r.proxied).length;
  const total = cand.length;
  let state = 'none';
  if (total === 0) state = 'empty';
  else if (on === total) state = 'all';
  else if (on > 0) state = 'mixed';
  return { on: on, total: total, state: state };
}

// ─────────────────────────────────────────────────────────────
// 적용 범위 계산 = dry-run 의 핵심
//   mode 'ip'     : content 가 지정한 IP 인 레코드만
//   mode 'all'    : 프록시 가능한 모든 레코드 (IP 무관)
//   mode 'manual' : 체크한 레코드만
//
//   targets 에는 "실제로 값이 바뀌는" 레코드만 담는다.
// ─────────────────────────────────────────────────────────────
export function resolveScope(zoneName, records, mode, desiredProxied, manualIds, ip) {
  const targets = [];
  const skipped = [];
  const manual = new Set(manualIds || []);

  for (const r of records) {
    if (PROXYABLE_TYPES.indexOf(r.type) === -1) {
      skipped.push({ record: r, reason: r.type + ' 타입은 프록시할 수 없습니다' });
      continue;
    }
    if (!r.proxiable) {
      skipped.push({ record: r, reason: '프록시할 수 없는 레코드입니다 (사설 IP 등)' });
      continue;
    }

    // 대상 서버 IP 가 아니면 무조건 보호. 수동 선택이어도 예외 없음.
    if (ip && r.content !== ip) {
      skipped.push({ record: r, reason: '보호 — ' + r.content + ' 를 가리킴' });
      continue;
    }
    if (mode === 'manual' && !manual.has(r.id)) {
      skipped.push({ record: r, reason: '선택 안 함' });
      continue;
    }
    // mode === 'all' 은 추가 필터 없음

    if (r.proxied === desiredProxied) {
      skipped.push({ record: r, reason: '이미 ' + (desiredProxied ? 'Proxied' : 'DNS only') });
      continue;
    }

    targets.push(r);
  }

  return { targets: targets, skipped: skipped };
}

// 캐시에서 서버 IP 분포를 뽑는다. 범위 버튼의 목록이 된다.
// A / AAAA 만 본다. CNAME 이 가리키는 호스트명(메일·CDN 등)은 일괄 변경 대상이 아니다.
export function collectIps(cache) {
  const map = new Map();
  for (const zid of Object.keys(cache)) {
    const recs = (cache[zid] && cache[zid].records) || [];
    for (const r of recs) {
      if (r.type !== 'A' && r.type !== 'AAAA') continue;
      if (!r.proxiable) continue;
      const cur = map.get(r.content) || { ip: r.content, count: 0, zones: new Set() };
      cur.count++;
      cur.zones.add(zid);
      map.set(r.content, cur);
    }
  }
  return Array.from(map.values())
    .map((v) => ({ ip: v.ip, count: v.count, zones: v.zones.size }))
    .sort((a, b) => b.count - a.count);
}

// Workers 런타임은 UTC 라서 그대로 쓰면 9시간 어긋난다.
// 로컬(KST)과 Workers 양쪽에서 같은 값이 나오도록 KST 로 고정한다.
function kstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

// 'YYYY-MM-DD HH:mm:ss' (KST)
export function nowStamp() {
  const d = kstNow();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
    p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds())
  );
}

export function monthKey() {
  const d = kstNow();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
