// 공통 화면 — 모든 메뉴 페이지가 불러 쓴다 (index.html · ip.html · …)
//
//   왼쪽 메뉴 · 위쪽 바의 2단계 인증 / 로그아웃 · 작은 입력 창(#mini) · OTP 관리 창(#otpDlg)
//
// 페이지 쪽 준비물: 위쪽 바에 #btnOtp · #btnLogout 버튼, 본문 앞에 <nav id="side" class="side">
// 메뉴를 추가할 때는 아래 MENU 에 한 줄 + 페이지 파일 하나.

export const $ = (s) => document.querySelector(s);
export const el = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };

// ── 왼쪽 메뉴 ────────────────────────────────────────────────
const ICON = {
  globe: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>',
  shield: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6l8-3z"/></svg>',
  list: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  gear: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  help: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.3-2.5 3.9M12 17h.01"/></svg>',
};
const MENU = [
  { sec: '관리' },
  { key: 'domains', href: '/', label: 'DNS · SSL/TLS', icon: ICON.globe },
  { key: 'ip', href: '/ip.html', label: 'IP Rules', icon: ICON.shield },
  { sec: '기록' },
  { key: 'log', href: '/#log', label: '변경 이력', icon: ICON.list },
  { sec: '시스템' },
  { key: 'settings', href: '/settings.html', label: '설정', icon: ICON.gear },
  { key: 'help', href: '/help.html', label: '도움말', icon: ICON.help },
];
const isIndex = (p) => p === '/' || p === '/index.html';

export function currentMenu() {
  const p = location.pathname;
  if (p === '/ip.html' || p === '/ip') return 'ip'; // Workers 는 /ip.html 을 /ip 로 돌려보낸다
  if (p === '/settings.html' || p === '/settings') return 'settings';
  if (p === '/help.html' || p === '/help') return 'help';
  if (isIndex(p)) return location.hash === '#log' ? 'log' : 'domains';
  return '';
}

function renderSide() {
  const side = $('#side');
  if (!side) return;
  side.innerHTML = '';
  const nav = el('div', 'side-in');
  side.append(nav);
  const cur = currentMenu();
  for (const m of MENU) {
    if (m.sec) { nav.append(el('div', 'sec', m.sec)); continue; }
    const a = el('a', m.key === cur ? 'on' : '');
    a.href = m.href;
    a.innerHTML = m.icon; // 위 ICON 상수 (고정 SVG)
    a.append(el('span', null, m.label));
    a.onclick = (e) => {
      // Ctrl/Shift/Cmd 클릭·가운데 클릭은 브라우저에 맡긴다 (새 탭으로 열기)
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      // 같은 페이지 안의 이동(DNS · SSL/TLS ↔ 변경 이력)은 새로 불러오지 않고 화면만 바꾼다
      const u = new URL(m.href, location.href);
      if (!(isIndex(u.pathname) && isIndex(location.pathname))) return;
      e.preventDefault();
      if (u.hash) { if (location.hash !== u.hash) location.hash = u.hash; }
      else if (location.hash) history.pushState(null, '', location.pathname);
      route();
    };
    nav.append(a);
  }
}

function route() {
  renderSide();
  window.dispatchEvent(new CustomEvent('shell:route', { detail: currentMenu() }));
}
window.addEventListener('hashchange', route);
window.addEventListener('popstate', route);

// ── 작업 중 표시 ──────────────────────────────────────────────
// 페이지가 일괄 적용 중이면 로그아웃·창 닫기를 막는다
let busyCheck = () => false;
export function setBusyCheck(fn) { busyCheck = fn; }
let miniLock = false; // OTP 요청 처리 중엔 #mini 를 닫지 못하게 (닫아도 서버에서는 적용되므로)

// ── 창 (#mini · #otpDlg) ─────────────────────────────────────
document.body.insertAdjacentHTML('beforeend', `
<dialog id="otpDlg">
  <div class="dlg-h">2단계 인증 — 등록된 OTP</div>
  <div class="dlg-b" id="otpB"></div>
  <div class="dlg-f">
    <button class="danger" id="otpOff">전체 해제</button>
    <span class="grow"></span>
    <button class="ghost" id="otpClose">닫기</button>
    <button class="primary" id="otpAdd">+ OTP 추가</button>
  </div>
</dialog>
<dialog id="mini">
  <div class="dlg-h" id="miniH"></div>
  <div class="dlg-b" id="miniB"></div>
  <div class="dlg-f">
    <button class="ghost" id="miniCancel">취소</button>
    <button class="primary" id="miniOk">확인</button>
  </div>
</dialog>`);

$('#mini').addEventListener('cancel', (ev) => { if (miniLock) ev.preventDefault(); });
$('#mini').addEventListener('keydown', (ev) => { if (miniLock && ev.key === 'Escape') ev.preventDefault(); });
$('#mini').addEventListener('mousedown', (ev) => {
  if (miniLock || busyCheck()) return;
  if (ev.target === ev.currentTarget) ev.currentTarget.close();
});

// ── 작은 입력/선택 창 (native prompt 대체) ────────────────────
// 한 번만 settle 되도록 가드를 둔다. Escape(cancel 이벤트)로 닫아도 null 로 정리된다.
export function miniOpen(title, build, showOk) {
  return new Promise((resolve) => {
    const d = $('#mini');
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      d.removeEventListener('close', onClose);
      if (d.open) d.close();
      resolve(v);
    };
    // 브라우저는 close 이벤트를 한 박자 늦게(다음 화면 갱신 때) 보낸다.
    // 창을 닫자마자 다시 열면 앞 창의 close 가 새 창에 도착해 새 창이 바로 닫히므로,
    // 창이 열려 있는 동안 온 close 는 무시한다.
    const onClose = () => {
      if (d.open) return;
      if (miniLock) { d.showModal(); return; } // 요청 처리 중에 닫혔으면 다시 연다 (결과를 기다린다)
      finish(null);
    };

    $('#miniH').textContent = title;
    const b = $('#miniB'); b.innerHTML = '';
    $('#miniOk').classList.toggle('hide', !showOk);
    $('#miniOk').textContent = '확인';
    $('#miniOk').disabled = false;
    $('#miniCancel').disabled = false;

    const focusTarget = build(b, finish);

    $('#miniCancel').onclick = () => { if (!miniLock) finish(null); };
    d.addEventListener('close', onClose);
    d.showModal();
    if (focusTarget) { focusTarget.focus(); if (focusTarget.select) focusTarget.select(); }
  });
}

export function askText(title, value, placeholder) {
  return miniOpen(title, (b, finish) => {
    const inp = el('input'); inp.type = 'text';
    inp.value = value || ''; inp.placeholder = placeholder || '';
    inp.style.width = '100%'; inp.style.height = '34px';
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(inp.value.trim() || null); } };
    b.append(inp);
    $('#miniOk').onclick = () => finish(inp.value.trim() || null);
    return inp;
  }, true);
}

export function askChoice(title, options, current) {
  return miniOpen(title, (b, finish) => {
    const list = el('div', 'choices');
    for (const o of options) {
      const btn = el('button', 'choice' + (o.value === current ? ' cur' : ''));
      btn.append(el('span', 'clabel', o.label));
      if (o.hint) btn.append(el('span', 'chint', o.hint));
      btn.onclick = () => finish(o.value);
      list.append(btn);
    }
    b.append(list);
    return null;
  }, false);
}

// 요청이 도는 동안 #mini 를 잠근다 (취소 · ESC · 바탕 클릭 무시, 확인 버튼 비활성)
async function locked(fn) {
  miniLock = true; $('#miniOk').disabled = true; $('#miniCancel').disabled = true;
  try { return await fn(); }
  finally { miniLock = false; $('#miniOk').disabled = false; $('#miniCancel').disabled = false; }
}

// ── 구글 OTP 2단계 인증 ──────────────────────────────────────
// Workers 에서만 동작한다. 로컬 서버(127.0.0.1)는 로그인이 없어서 버튼을 숨긴다.
// 사람마다 따로 등록한다. 처음 등록한 사람이 관리자 — 추가·사용중지·삭제는 관리자만.
const otp = { enabled: false, me: null, isOwner: false, devices: [] };
const STALE_MSG = '목록이 바뀌었습니다. 다시 열어서 하세요.';

async function otpApi(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('세션이 만료되었습니다.'); }
  const j = await res.json().catch(() => null);
  if (!j) throw new Error('HTTP ' + res.status);
  if (!res.ok) throw new Error(j.message || j.error || ('HTTP ' + res.status));
  return j;
}

export async function otpStatus() {
  const b = $('#btnOtp'), lo = $('#btnLogout');
  if (!b) return;
  try {
    const j = await otpApi('/auth/otp/status');
    Object.assign(otp, { enabled: j.enabled, me: j.me, isOwner: j.isOwner, devices: j.devices || [] });
    b.textContent = '2단계 인증 ' + (otp.enabled ? 'ON' : 'OFF');
    b.title = otp.me ? '로그인: ' + otp.me.name + (otp.me.owner ? ' (관리자)' : '') : '로그인할 때 구글 OTP 6자리를 함께 받습니다';
    b.classList.toggle('on', otp.enabled);
    b.classList.remove('hide');
    if (lo) lo.classList.remove('hide');
  } catch (e) {
    b.classList.add('hide');
    if (lo) lo.classList.add('hide');
  }
}

// 6자리 입력 칸 + 확인 버튼. onOk(code) 가 오류 문자열을 돌려주면 창을 닫지 않고 보여준다.
function otpCodeInput(b, finish, okLabel, onOk, extraCheck) {
  const inp = el('input', 'otp-in'); inp.type = 'text';
  inp.inputMode = 'numeric'; inp.maxLength = 6; inp.placeholder = '000000';
  inp.autocomplete = 'one-time-code';
  const err = el('div', 'otp-err');
  b.append(inp, err);
  const go = async () => {
    if (miniLock) return;
    const pre = extraCheck ? extraCheck() : null;
    if (pre) { err.textContent = pre; return; }
    const code = inp.value.replace(/[^0-9]/g, '');
    if (code.length !== 6) { err.textContent = '6자리 숫자를 입력하세요.'; inp.focus(); return; }
    err.textContent = '';
    let msg = null;
    try { msg = await locked(() => onOk(code)); }
    catch (e) { msg = e.message; }
    if (msg) { err.textContent = msg; inp.select(); } else finish(true);
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
  $('#miniOk').textContent = okLabel;
  $('#miniOk').onclick = go;
  return inp;
}

function otpNameInput(value, placeholder) {
  const inp = el('input'); inp.type = 'text';
  inp.value = value || ''; inp.placeholder = placeholder || ''; inp.maxLength = 30;
  inp.className = 'otp-name';
  return inp;
}

// QR 스캔 → 앱에 뜬 코드 입력 → 맞으면 그때 적용
// expect — 요청한 작업. 서버 응답의 mode 가 다르면(그 사이 목록이 바뀜) 진행하지 않는다
async function otpRegister(data, expect) {
  if (!data) return false;
  if (data.mode !== expect) { alert(STALE_MSG); return false; }
  const who = data.account;
  const ok = await miniOpen(data.mode === 'rekey' ? '휴대폰 변경 — ' + who : '구글 OTP 등록 — ' + who, (b, finish) => {
    const steps = el('ol', 'otp-steps');
    steps.append(el('li', null, (data.mode === 'add' ? who + ' 님의 ' : '') + '휴대폰 Google OTP 앱에서 + 를 누르고 QR 코드를 스캔합니다.'));
    steps.append(el('li', null, '스캔이 안 되면 "설정 키 입력"에 아래 키를 넣습니다.'));
    steps.append(el('li', null, '그 앱에 표시된 6자리를 입력하면 등록이 끝납니다.'));
    const qr = el('div', 'otp-qr'); qr.innerHTML = data.svg; // Worker 가 만든 SVG
    const key = el('div', 'otp-key', data.secret.replace(/(.{4})/g, '$1 ').trim());
    key.title = data.issuer + ' · ' + data.account;
    b.append(steps, qr, key);
    return otpCodeInput(b, finish, '등록', async (code) => {
      await otpApi('/auth/otp/enable', { code });
      return null;
    });
  }, true);
  if (!ok) return false;
  if (data.mode === 'first') alert('구글 OTP 가 등록되었습니다. ' + who + ' 님이 관리자입니다.\n다음 로그인부터 비밀번호와 OTP 6자리를 함께 입력합니다.');
  else if (data.mode === 'add') alert(who + ' 님의 OTP 가 등록되었습니다.');
  else alert('휴대폰을 바꿨습니다. 예전 휴대폰의 OTP 는 더 이상 쓸 수 없습니다.');
  return true;
}

// 처음 등록 — 이 사람이 관리자가 된다
async function otpFirst() {
  let data = null;
  const ok = await miniOpen('구글 OTP 등록', (b, finish) => {
    b.append(el('div', 'otp-msg', '처음 등록하는 사람이 관리자가 됩니다. 관리자만 다른 사람을 추가하거나 사용중지할 수 있습니다.'));
    b.append(el('label', 'otp-lab', '이름'));
    const name = otpNameInput('관리자', '예: 홍길동 폰');
    b.append(name);
    name.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#miniOk').click(); } };
    const err = el('div', 'otp-err'); b.append(err);
    $('#miniOk').textContent = '다음';
    $('#miniOk').onclick = async () => {
      if (miniLock) return;
      const v = name.value.trim();
      if (!v) { err.textContent = '이름을 입력하세요.'; return; }
      try { data = await locked(() => otpApi('/auth/otp/setup', { mode: 'first', name: v })); finish(true); }
      catch (e) { err.textContent = e.message; }
    };
    return name;
  }, true);
  if (ok) await otpRegister(data, 'first');
  await otpStatus();
}

// 관리자 확인이 필요한 작업 — 관리자의 현재 OTP 를 받는다
//   add — 이름 + 코드 · rekey — 코드 · off — 코드
async function otpOwnerStep(kind) {
  const title = { add: 'OTP 추가', rekey: '휴대폰 변경', off: '2단계 인증 전체 해제' }[kind];
  let result = null;
  const ok = await miniOpen(title, (b, finish) => {
    let name = null;
    if (kind === 'add') {
      b.append(el('label', 'otp-lab', '추가할 사람 이름'));
      name = otpNameInput('', '예: 김대리');
      b.append(name);
    }
    if (kind === 'off') b.append(el('div', 'otp-msg', '모든 사람의 OTP 를 지우고 비밀번호만으로 로그인하게 됩니다. 로그인해 둔 다른 창은 모두 끊깁니다.'));
    b.append(el('label', 'otp-lab', '관리자 확인 — 지금 내 앱에 표시된 6자리'));
    const code = otpCodeInput(b, finish, kind === 'off' ? '전체 해제' : '다음', async (c) => {
      if (kind === 'add') result = await otpApi('/auth/otp/setup', { mode: 'add', name: name.value.trim(), code: c });
      else if (kind === 'rekey') result = await otpApi('/auth/otp/setup', { mode: 'rekey', code: c });
      else result = await otpApi('/auth/otp/off', { code: c });
      return null;
    }, () => (name && !name.value.trim() ? '이름을 입력하세요.' : null));
    return name || code;
  }, true);
  return ok ? result : null;
}

// ── 관리 화면 ──
const fmtWhen = (s) => (s ? s.slice(5, 16) : '—');

function renderOtpPanel() {
  const body = $('#otpB');
  body.innerHTML = '';
  if (otp.me) body.append(el('div', 'otp-me', '지금 로그인: ' + otp.me.name + (otp.me.owner ? ' (관리자)' : '')));
  const t = el('table', 'otptbl');
  const hr = el('tr');
  for (const h of ['이름', '등록', '마지막 로그인', '상태', '']) hr.append(el('th', null, h));
  const thead = el('thead'); thead.append(hr); t.append(thead);
  const tb = el('tbody');
  for (const d of otp.devices) {
    const tr = el('tr', d.enabled ? '' : 'off');
    const nm = el('td', 'nm');
    nm.append(el('span', null, d.name));
    if (d.owner) nm.append(el('span', 'otp-tag', '관리자'));
    if (otp.me && otp.me.id === d.id) nm.append(el('span', 'otp-tag me', '나'));
    tr.append(nm);
    tr.append(el('td', 'when', fmtWhen(d.since)));
    tr.append(el('td', 'when', fmtWhen(d.lastLogin)));
    const st = el('td');
    st.append(el('span', d.enabled ? 'chip ok' : 'chip', d.enabled ? '사용 중' : '중지됨'));
    tr.append(st);
    const act = el('td', 'act');
    if (otp.isOwner) {
      const btn = (label, fn, cls) => { const x = el('button', 'tiny' + (cls ? ' ' + cls : ''), label); x.onclick = fn; act.append(x); };
      btn('이름 변경', () => otpDeviceAction(d, 'rename'));
      if (d.owner) {
        btn('휴대폰 변경', otpRekey);
      } else {
        if (d.enabled) btn('사용중지', () => otpDeviceAction(d, 'disable'));
        else btn('다시 사용', () => otpDeviceAction(d, 'enable'));
        btn('삭제', () => otpDeviceAction(d, 'delete'), 'danger');
      }
    }
    tr.append(act);
    tb.append(tr);
  }
  t.append(tb);
  body.append(t);
  if (!otp.isOwner) body.append(el('div', 'otp-note', '추가·사용중지·삭제는 관리자만 할 수 있습니다.'));
  $('#otpAdd').classList.toggle('hide', !otp.isOwner);
  $('#otpOff').classList.toggle('hide', !otp.isOwner);
}

async function refreshOtpPanel() {
  await otpStatus();
  if (!otp.enabled) { if ($('#otpDlg').open) $('#otpDlg').close(); return; }
  renderOtpPanel();
}

async function openOtpPanel() {
  renderOtpPanel();
  $('#otpDlg').showModal();
  refreshOtpPanel();
}

async function otpDeviceAction(d, action) {
  let name;
  if (action === 'rename') {
    name = await askText('이름 변경', d.name, '예: 김대리');
    if (!name || name === d.name) return;
  } else if (action === 'disable') {
    if (!confirm(d.name + ' 님의 OTP 를 사용중지합니다.\n그 OTP 로는 로그인할 수 없고, 로그인해 둔 창도 바로 끊깁니다.\n\n진행할까요?')) return;
  } else if (action === 'delete') {
    if (!confirm(d.name + ' 님의 OTP 를 삭제합니다.\n다시 쓰려면 새로 등록해야 합니다.\n\n진행할까요?')) return;
  }
  try {
    await otpApi('/auth/otp/device', { id: d.id, action, name });
  } catch (e) {
    alert(e.message);
  }
  await refreshOtpPanel();
}

async function otpRekey() {
  const data = await otpOwnerStep('rekey');
  if (data) await otpRegister(data, 'rekey');
  await refreshOtpPanel();
}

$('#otpAdd').onclick = async () => {
  const data = await otpOwnerStep('add');
  if (data) await otpRegister(data, 'add');
  await refreshOtpPanel();
};
$('#otpOff').onclick = async () => {
  const r = await otpOwnerStep('off');
  await refreshOtpPanel();
  if (r) alert('2단계 인증을 전체 해제했습니다. 이제 비밀번호만으로 로그인합니다.');
};
$('#otpClose').onclick = () => $('#otpDlg').close();
$('#otpDlg').addEventListener('mousedown', (ev) => { if (ev.target === ev.currentTarget) ev.currentTarget.close(); });

// ── 시작 ──
function init() {
  renderSide();
  const b = $('#btnOtp');
  if (b) b.onclick = async () => {
    await otpStatus(); // 다른 창에서 바뀌었을 수 있으니 누를 때마다 새로 읽는다
    if (otp.enabled) return openOtpPanel();
    otpFirst();
  };
  const lo = $('#btnLogout');
  if (lo) lo.onclick = () => { if (!busyCheck()) location.href = '/logout'; };
  otpStatus();
}
init();
