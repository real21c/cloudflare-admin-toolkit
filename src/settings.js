// 설정 메뉴 — 화면에서 바꾸는 값
//
// 저장소 'settings' 에는 화면에서 바꾼 값만 둔다. 없는 항목은 기본값
// (Workers = wrangler.jsonc 의 vars, 로컬 = config.json) 을 그대로 쓴다.
// 토큰 · 비밀번호 같은 비밀값은 여기 두지 않는다 (시크릿).
//
// 바꿀 수 있는 사람: OTP 관리자 (OTP 가 없으면 로그인한 사람, 로컬은 누구나)

// 묶음 — 설정 화면에서 이 순서로 나눠 보여준다
export const SECTIONS = [
  { key: 'domain', label: 'DNS · SSL/TLS', help: 'DNS · SSL/TLS 메뉴(프록시 · SSL · 캐시)에서 쓰는 값' },
  { key: 'ip', label: 'IP Rules', help: 'IP Rules 메뉴(404 가드 룰 관리)에서 쓰는 값' },
  { key: 'common', label: '로그인 · 보안', help: '로그인과 2단계 인증(구글 OTP)에 쓰는 값' },
];

export const FIELDS = [
  { key: 'serverIp', section: 'domain', label: '대상 서버 IP', type: 'ip',
    help: '프록시·SSL 일괄 변경 대상. 이 IP 를 가리키는 A/AAAA 레코드만 바뀌고 나머지는 보호' },
  { key: 'defaultGroup', section: 'domain', label: '기본 그룹 탭', type: 'group',
    help: 'DNS · SSL/TLS 를 열면 처음 보이는 그룹' },
  { key: 'otpIssuer', section: 'common', label: 'OTP 앱 이름', type: 'text', max: 30,
    help: '구글 OTP 앱에 보이는 이름. 새로 등록하는 OTP 부터 적용 (이미 등록한 것은 앱에서 이름 수정)' },
  { key: 'ipPairZoneName', section: 'ip', label: '자산존', type: 'domain',
    help: '404 가드가 IP마다 Allow 예외 룰을 만드는 존. 계정 룰을 지울 때 이 존의 같은 IP Allow 룰도 함께 지운다' },
  { key: 'ipRateBudget', section: 'ip', label: '5분 호출 상한', type: 'int', min: 50, max: 1200, unit: '회',
    help: 'Cloudflare 한도 5분 1,200회를 대시보드·404 가드와 나눠 쓴다. IP Rules 화면이 이 값을 넘지 않게 늦춘다' },
  { key: 'cacheTtlMinutes', section: 'domain', label: '상태 캐시 시간', type: 'int', min: 1, max: 1440, unit: '분',
    help: '도메인 SSL·프록시 상태를 Cloudflare 에서 다시 읽기 전까지 기억하는 시간' },
];
const BY_KEY = Object.assign(Object.create(null), Object.fromEntries(FIELDS.map((f) => [f.key, f])));
export const isField = (k) => Object.prototype.hasOwnProperty.call(BY_KEY, k);

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(xn--[a-z0-9-]{1,59}|[a-z]{2,63})$/;
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x1f\x7f]/;

export async function loadSettings(store) {
  const v = await store.get('settings', null);
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// 기본값 위에 바꾼 값을 덮는다
export function applySettings(base, saved) {
  const out = Object.assign({}, base);
  for (const f of FIELDS) {
    if (saved[f.key] !== undefined && saved[f.key] !== null && saved[f.key] !== '') out[f.key] = saved[f.key];
  }
  // 자산존 이름을 화면에서 바꿨으면, 설정 파일에 고정한 존 ID(IP_PAIR_ZONE_ID) 대신 그 이름으로 존을 찾게 한다
  if (saved.ipPairZoneName) out.ipPairZoneId = '';
  return out;
}

export function pickDefaults(config) {
  const out = {};
  for (const f of FIELDS) out[f.key] = config[f.key] === undefined ? '' : config[f.key];
  return out;
}

// 한 항목 검사 → 저장할 값. 틀리면 Error
export function validateField(key, raw) {
  if (!isField(key)) throw new Error('알 수 없는 항목: ' + key);
  const f = BY_KEY[key];
  // 문자열(또는 숫자 칸의 숫자)만 받는다 — 객체·배열은 거절
  if (!(typeof raw === 'string' || (f.type === 'int' && typeof raw === 'number'))) throw new Error(f.label + ': 값 형식이 잘못되었습니다');
  if (f.type === 'int') {
    if (typeof raw === 'string' && !/^\s*\d+\s*$/.test(raw)) throw new Error(f.label + ': ' + f.min + '~' + f.max + ' 사이의 정수');
    const n = Number(raw);
    if (!Number.isInteger(n) || n < f.min || n > f.max) throw new Error(f.label + ': ' + f.min + '~' + f.max + ' 사이의 정수');
    return n;
  }
  const s = String(raw == null ? '' : raw).trim();
  if (!s) throw new Error(f.label + ': 비워 둘 수 없습니다 (기본값으로 되돌리려면 "기본값으로")');
  if (CTRL.test(s)) throw new Error(f.label + ': 쓸 수 없는 문자가 있습니다');
  if (f.type === 'ip') {
    if (IPV4.test(s)) return s;
    if (s.length <= 45 && s.includes(':') && /^[0-9a-f:.]+$/i.test(s)) {
      try {
        const h = new URL('http://[' + s + ']/').hostname; // 풀리면 짧은 표준 표기 [2001:db8::1]
        return h.slice(1, -1);
      } catch (e) { /* 아래에서 거절 */ }
    }
    throw new Error(f.label + ': IP 주소 형식이 아닙니다 (예: 203.0.113.10)');
  }
  if (f.type === 'domain') {
    const d = s.toLowerCase().replace(/\.$/, '');
    if (!DOMAIN.test(d)) throw new Error(f.label + ': 도메인 형식이 아닙니다 (예: example.com)');
    return d;
  }
  if (f.type === 'text') {
    if (s.length > f.max) throw new Error(f.label + ': ' + f.max + '자 이하');
    if (s.includes(':')) throw new Error(f.label + ': 콜론(:)은 쓸 수 없습니다 (OTP 앱에서 이름 구분자로 쓰임)');
    return s;
  }
  // group
  if (s.length > 40) throw new Error(f.label + ': 40자 이하');
  return s;
}

export function fieldLabel(key) {
  if (!isField(key)) return key;
  const f = BY_KEY[key];
  const sec = SECTIONS.find((s) => s.key === f.section);
  return (sec ? sec.label + ' › ' : '') + f.label;
}
