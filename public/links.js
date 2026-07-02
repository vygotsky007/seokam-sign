'use strict';

// 세션 만료 등으로 관리 API가 401을 주면 로그인 화면으로 보낸다.
(function () {
  const _f = window.fetch;
  window.fetch = async function (...args) {
    const r = await _f.apply(this, args);
    if (r.status === 401) location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    return r;
  };
})();

const TYPE_KO = { text: '텍스트', confirm: '따라쓰기', checkbox: '동의 체크', signature: '손글씨 서명' };
const docId = new URLSearchParams(location.search).get('doc');
const state = { doc: null, fields: [], period: 3 };

let toastTimer = null;
function toast(m) {
  const t = document.getElementById('toast');
  t.textContent = m; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}
function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtDate(iso) {
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtShort(iso) { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}`; }

fetch('/api/health').then(r => r.json()).then(h => {
  const b = document.getElementById('storeBadge');
  if (h.store === 'supabase') { b.textContent = 'Supabase'; b.classList.add('supa'); }
  else { b.textContent = '로컬 폴백'; b.classList.add('local'); }
}).catch(() => {});

if (!docId) { toast('문서 ID가 없습니다.'); }
else {
  document.getElementById('backBtn').href = `/?doc=${docId}`;
  document.getElementById('subsBtn').href = `/submissions.html?doc=${docId}`;
  init();
}

async function init() {
  try {
    const res = await fetch(`/api/documents/${docId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '문서 로드 실패');
    state.doc = data.document;
    state.fields = data.fields || [];
    document.getElementById('docTitle').textContent = state.doc.title || '문서';
    document.getElementById('docSub').textContent =
      `필드 ${state.fields.length}개 · 필수 ${state.fields.filter(f => f.required).length}개`;
    renderFields();
    loadLinks();
  } catch (e) { toast('오류: ' + e.message); }
}

// ---- 필수 항목 설정 ----
function renderFields() {
  const box = document.getElementById('fieldList');
  box.innerHTML = '';
  if (!state.fields.length) { box.innerHTML = '<p class="sub">지정된 필드가 없습니다. 문서 편집에서 먼저 필드를 그려주세요.</p>'; return; }
  state.fields.forEach(f => {
    const row = document.createElement('div');
    row.className = 'frow';
    const meta = f.type === 'confirm' && f.answer ? `"${esc(f.answer)}"` : TYPE_KO[f.type];
    row.innerHTML =
      `<span><span class="dot ${f.required ? 'req' : 'opt'}"></span>${esc(f.label)}<span class="fmeta">${esc(meta)} · ${f.page + 1}쪽</span></span>`;
    const sw = document.createElement('div');
    sw.className = 'sw' + (f.required ? ' on req' : '');
    sw.innerHTML = '<div class="knob"></div>';
    sw.addEventListener('click', () => {
      f.required = !f.required;
      sw.classList.toggle('on', f.required);
      sw.classList.toggle('req', f.required);
      const r = row.querySelector('.dot');
      r.classList.toggle('req', f.required); r.classList.toggle('opt', !f.required);
    });
    row.appendChild(sw);
    box.appendChild(row);
  });
}

document.getElementById('saveReq').addEventListener('click', async () => {
  try {
    const updates = state.fields.map(f => ({ id: f.id, required: f.required }));
    const res = await fetch(`/api/documents/${docId}/fields/required`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '저장 실패');
    document.getElementById('docSub').textContent =
      `필드 ${state.fields.length}개 · 필수 ${state.fields.filter(f => f.required).length}개`;
    toast('필수 설정 저장 완료');
  } catch (e) { toast('오류: ' + e.message); }
});

// ---- 만료 기간 선택 ----
document.querySelectorAll('#periodPills .pill').forEach(p => {
  p.addEventListener('click', () => {
    document.querySelectorAll('#periodPills .pill').forEach(x => x.classList.remove('active'));
    p.classList.add('active');
    document.getElementById('customDays').value = '';
    state.period = parseInt(p.dataset.days, 10);
  });
});
document.getElementById('customDays').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10);
  if (Number.isFinite(v) && v >= 1) {
    document.querySelectorAll('#periodPills .pill').forEach(x => x.classList.remove('active'));
    state.period = v;
  }
});

// ---- 1회용 토글 ----
const oneTimeSw = document.getElementById('oneTimeSw');
oneTimeSw.addEventListener('click', () => oneTimeSw.classList.toggle('on'));

// ---- 링크 생성 ----
document.getElementById('genBtn').addEventListener('click', async () => {
  let count = parseInt(document.getElementById('linkCount').value, 10);
  if (!Number.isFinite(count) || count < 1) count = 1;
  const days = state.period;
  const oneTime = oneTimeSw.classList.contains('on');
  try {
    const res = await fetch(`/api/documents/${docId}/links`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count, expires_days: days, one_time: oneTime }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '생성 실패');
    toast(`링크 ${data.count}개 생성 · 마감 ${fmtShort(data.expires_at)}`);
    loadLinks();
  } catch (e) { toast('오류: ' + e.message); }
});

// ---- 링크 목록 ----
let allLinks = [];
async function loadLinks() {
  try {
    const res = await fetch(`/api/documents/${docId}/links`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '목록 실패');
    allLinks = data.links || [];
    renderLinks();
  } catch (e) { toast('오류: ' + e.message); }
}

function linkUrl(token) { return `${location.origin}/f/${token}`; }
function guideText(token) {
  const title = state.doc?.title || '동의서';
  const dl = allLinks[0] ? fmtShort(allLinks[0].expires_at) : '';
  return `[석암초] ${title}입니다. 아래 링크에서 작성·서명해 주세요. (마감 ${dl}) ${linkUrl(token)}`;
}

const STATUS_KO = { open: '미작성', done: '작성됨', closed: '닫힘', expired: '만료' };

function renderLinks() {
  const card = document.getElementById('listCard');
  const list = document.getElementById('linkList');
  if (!allLinks.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  document.getElementById('deadline').textContent = `· 마감 ${fmtDate(allLinks[0].expires_at)}`;
  list.innerHTML = '';
  allLinks.forEach(l => {
    const row = document.createElement('div');
    row.className = 'linkrow';
    const closed = l.status === 'closed';
    row.innerHTML =
      `<span class="seq">#${l.seq}</span>` +
      `<span class="url ${closed ? 'closed' : ''}">${esc(linkUrl(l.token))}</span>` +
      `<span class="chip ${l.status}">${STATUS_KO[l.status]}</span>`;
    const copyB = document.createElement('button'); copyB.className = 'ico'; copyB.title = '안내문구 복사'; copyB.textContent = '⧉';
    copyB.addEventListener('click', () => { copy(guideText(l.token)); toast('안내문구 복사됨'); });
    const qrB = document.createElement('button'); qrB.className = 'ico'; qrB.title = 'QR'; qrB.textContent = '▦';
    qrB.addEventListener('click', () => showQR(linkUrl(l.token)));
    const tg = document.createElement('span'); tg.className = 'toggle-link';
    tg.textContent = closed ? '열기' : '닫기';
    tg.addEventListener('click', () => toggleLink(l.id, !closed));
    row.appendChild(copyB); row.appendChild(qrB); row.appendChild(tg);
    list.appendChild(row);
  });
}

async function toggleLink(id, close) {
  try {
    const res = await fetch(`/api/links/${id}/toggle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_closed: close }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '실패');
    loadLinks();
  } catch (e) { toast('오류: ' + e.message); }
}

document.getElementById('copyAll').addEventListener('click', () => {
  if (!allLinks.length) return;
  const text = allLinks.filter(l => l.status !== 'closed').map(l => guideText(l.token)).join('\n\n');
  copy(text); toast(`안내문구 ${allLinks.filter(l => l.status !== 'closed').length}건 복사됨`);
});

function copy(text) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  else fallbackCopy(text);
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta);
  ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove();
}

function showQR(url) {
  const box = document.getElementById('qrBox'); box.innerHTML = '';
  document.getElementById('qrUrl').textContent = url;
  new QRCode(box, { text: url, width: 200, height: 200 });
  document.getElementById('qrModal').classList.add('show');
}
