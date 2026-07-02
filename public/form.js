'use strict';

const TOKEN = decodeURIComponent((location.pathname.match(/\/f\/([^/]+)/) || [])[1] || '');
const state = { fields: [], values: {}, sigData: {}, lastSig: null, pages: [] };

let toastTimer = null;
function toast(m) { const t = document.getElementById('toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2400); }
function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function normalize(s) { return (s || '').toString().replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase(); }
function fmtDate(iso) { const d = new Date(iso); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
function todayStr() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }

const BLOCK_MSG = {
  notfound: '존재하지 않는 링크입니다. 주소를 다시 확인해 주세요.',
  closed: '이미 작성이 완료되었거나 닫힌 링크입니다.',
  expired: '제출 마감 기간이 지났습니다. 담당 선생님께 문의해 주세요.',
  error: '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
};

init();

async function init() {
  if (!TOKEN) return showBlocked('notfound');
  try {
    const res = await fetch(`/api/f/${TOKEN}`);
    const data = await res.json();
    if (!data.ok) return showBlocked(data.reason || 'error', data.title);
    state.fields = data.fields || [];
    state.values = data.values || {};
    document.getElementById('title').textContent = data.title || '동의서';
    document.getElementById('deadline').textContent = '제출 마감 ' + fmtDate(data.expires_at);
    if (data.memo && data.memo.trim()) { const m = document.getElementById('memoBox'); m.textContent = data.memo; m.classList.remove('hidden'); }
    // 자동 날짜 기본값
    state.fields.filter(f => f.type === 'date' && f.answer !== 'manual').forEach(f => { if (!state.values[f.id]) state.values[f.id] = todayStr(); });
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('bar').classList.remove('hidden');
    await renderPdf();
    revalidate();
  } catch (e) { showBlocked('error'); }
}

function showBlocked(reason, title) {
  document.getElementById('blockedMsg').textContent = BLOCK_MSG[reason] || BLOCK_MSG.error;
  if (title) document.getElementById('blockedTitle').textContent = title;
  document.getElementById('blocked').classList.remove('hidden');
}

// ---- PDF 렌더 + 인플레이스 박스 ----
async function renderPdf() {
  const pagesEl = document.getElementById('pages');
  try {
    const pdf = await pdfjsLib.getDocument(`/api/f/${TOKEN}/pdf`).promise;
    const targetW = Math.min(440, document.querySelector('.wrap').clientWidth - 4);
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const base = page.getViewport({ scale: 1 });
      const scale = targetW / base.width;
      const vp = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const wrap = document.createElement('div'); wrap.className = 'page-wrap'; wrap.style.width = vp.width + 'px'; wrap.style.height = vp.height + 'px';
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
      const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
      const ov = document.createElement('div'); ov.className = 'ov';
      wrap.appendChild(canvas); wrap.appendChild(ov); pagesEl.appendChild(wrap);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      state.pages[p - 1] = { wrap, ov, w: vp.width, h: vp.height };
    }
    // 기존 서명 미리보기 로드
    state.fields.filter(f => f.type === 'signature').forEach(f => {
      if (typeof state.values[f.id] === 'string' && state.values[f.id].startsWith('responses/')) {
        const img = new Image();
        img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').drawImage(img, 0, 0); state.sigData[f.id] = c.toDataURL('image/png'); renderBoxes(); revalidate(); };
        img.src = `/api/f/${TOKEN}/sig/${f.id}?t=${Date.now()}`;
      }
    });
    renderBoxes();
  } catch (e) {
    document.getElementById('hint').textContent = '문서를 불러오지 못했습니다. 새로고침 해주세요.';
  }
}

function renderBoxes() {
  state.pages.forEach((pg, idx) => {
    if (!pg) return;
    pg.ov.innerHTML = '';
    state.fields.forEach((f, i) => {
      if (f.page !== idx) return;
      const box = document.createElement('div');
      box.className = 'fb';
      box.dataset.fid = f.id;
      box.style.left = (f.x * pg.w) + 'px'; box.style.top = (f.y * pg.h) + 'px';
      box.style.width = (f.w * pg.w) + 'px'; box.style.height = (f.h * pg.h) + 'px';
      paintBox(box, f, i);
      box.addEventListener('click', (e) => { e.stopPropagation(); onBoxTap(f); });
      pg.ov.appendChild(box);
    });
  });
}

function paintBox(box, f, i) {
  const filled = isFilled(f);
  box.classList.remove('opt', 'done');
  if (filled) box.classList.add('done');
  else if (!f.required) box.classList.add('opt');
  box.innerHTML = `<span class="pin">${i + 1}</span>`;
  if (f.type === 'checkbox') {
    if (state.values[f.id] === true) box.innerHTML += '<span class="chk">✓</span>';
  } else if (f.type === 'radio') {
    if (state.values[f.grp] === f.id) box.innerHTML += '<span class="chk radio">✓</span>';
  } else if (f.type === 'signature') {
    if (state.sigData[f.id]) box.innerHTML += `<img src="${state.sigData[f.id]}" alt="서명"/>`;
  } else {
    const v = state.values[f.id];
    if (v) box.innerHTML += `<span class="val">${esc(v)}</span>`;
  }
}

function onBoxTap(f) {
  if (f.type === 'checkbox') {
    state.values[f.id] = !(state.values[f.id] === true);
    afterChange(f);
  } else if (f.type === 'radio') {
    state.values[f.grp] = f.id; // 같은 그룹 자동 택1
    afterChange(f);
  } else if (f.type === 'signature') {
    openSignSheet(f);
  } else { // text / confirm / date(manual)
    if (f.type === 'date' && f.answer !== 'manual') { toast('제출일이 자동 입력됩니다'); return; }
    openTextSheet(f);
  }
}

function afterChange(changed) {
  renderBoxes(); revalidate();
  // 방금 작성한 필드가 채워졌으면 다음 미작성 필수 필드로 자동 이동.
  if (changed && isFilled(changed)) {
    const nx = firstUnfilledRequired();
    if (nx && nx.id !== changed.id) focusField(nx);
  }
}

// 문서 순서(sort) 기준 첫 미작성 필수 필드
function firstUnfilledRequired() {
  return state.fields.filter(f => f.required).find(f => !isFilled(f)) || null;
}
// 해당 필드 박스로 스크롤 + 강조 테두리
function focusField(f) {
  const pg = state.pages[f.page];
  if (!pg) return;
  const box = pg.ov.querySelector(`.fb[data-fid="${f.id}"]`);
  if (!box) return;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  box.classList.remove('flash');
  void box.offsetWidth; // reflow 로 애니메이션 재생 보장
  box.classList.add('flash');
  setTimeout(() => box.classList.remove('flash'), 1500);
}

// ---- 바텀시트: 텍스트/날짜 ----
function openTextSheet(f) {
  const inner = document.getElementById('sheetInner');
  const isDate = f.type === 'date';
  const isConfirm = f.type === 'confirm';
  inner.innerHTML =
    `<h2>${esc(f.label)}</h2><div class="sub">${isConfirm ? '아래 문구를 그대로 따라 적어주세요' : (isDate ? '날짜를 선택하세요' : '내용을 입력하세요')}</div>` +
    (isConfirm ? `<div class="copytarget">"${esc(f.answer || '')}"</div>` : '') +
    `<input id="sheetInput" type="${isDate ? 'date' : 'text'}" value="${esc(state.values[f.id] || '')}" placeholder="${isConfirm ? '여기에 따라쓰기' : '입력'}"/>` +
    (isConfirm ? `<div class="match no" id="sheetMatch">공백·기호는 무시하고 글자만 맞으면 됩니다</div>` : '') +
    `<div class="sheet-actions"><button class="cancel" id="sheetCancel">취소</button><button class="ok" id="sheetOk">확인</button></div>`;
  openSheet();
  const input = document.getElementById('sheetInput');
  setTimeout(() => input.focus(), 100);
  if (isConfirm) input.addEventListener('input', () => {
    const el = document.getElementById('sheetMatch'); const v = input.value;
    if (!v.trim()) { el.className = 'match no'; el.textContent = '공백·기호는 무시하고 글자만 맞으면 됩니다'; }
    else if (normalize(v) === normalize(f.answer)) { el.className = 'match ok'; el.textContent = '✓ 일치합니다'; }
    else { el.className = 'match no'; el.textContent = '아직 문구와 다릅니다'; }
  });
  document.getElementById('sheetCancel').onclick = closeSheet;
  document.getElementById('sheetOk').onclick = () => { state.values[f.id] = input.value; closeSheet(); afterChange(f); };
}

// ---- 바텀시트: 서명 ----
function openSignSheet(f) {
  const inner = document.getElementById('sheetInner');
  inner.innerHTML =
    `<h2>손글씨 서명</h2><div class="sub">${esc(f.label)} · 손가락으로 그려주세요</div>` +
    `<div class="sigpad"><canvas id="sigCanvas"></canvas>` +
    `<button class="reuse" id="sigReuse" style="display:none">이전 서명 사용</button>` +
    `<button class="clr" id="sigClr">지우기</button>` +
    `<div class="ph" id="sigPh">여기에 손가락으로 서명</div></div>` +
    `<div class="sheet-actions"><button class="cancel" id="sheetCancel">취소</button><button class="ok" id="sheetOk">확인</button></div>`;
  openSheet();
  const canvas = document.getElementById('sigCanvas');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssW = rect.width || 400, cssH = 150;
  canvas.width = Math.floor(cssW * dpr); canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.lineWidth = 3.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#15203a';
  let drawing = false, dirty = false, last = null;
  // 기존 서명 있으면 표시
  if (state.sigData[f.id]) { const img = new Image(); img.onload = () => { ctx.drawImage(img, 0, 0, cssW, cssH); dirty = true; document.getElementById('sigPh').style.display = 'none'; }; img.src = state.sigData[f.id]; }
  const pos = e => { const r = canvas.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: t.clientX - r.left, y: t.clientY - r.top }; };
  const start = e => { e.preventDefault(); drawing = true; last = pos(e); document.getElementById('sigPh').style.display = 'none'; };
  const move = e => { if (!drawing) return; e.preventDefault(); const p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; dirty = true; };
  const end = () => { drawing = false; };
  canvas.addEventListener('pointerdown', start); canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointerleave', end);
  const reuseBtn = document.getElementById('sigReuse');
  if (state.lastSig) { reuseBtn.style.display = 'block'; reuseBtn.onclick = () => { const img = new Image(); img.onload = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, cssW, cssH); dirty = true; document.getElementById('sigPh').style.display = 'none'; }; img.src = state.lastSig; }; }
  document.getElementById('sigClr').onclick = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; document.getElementById('sigPh').style.display = 'flex'; };
  document.getElementById('sheetCancel').onclick = closeSheet;
  document.getElementById('sheetOk').onclick = () => {
    if (!dirty) { delete state.sigData[f.id]; }
    else { const out = document.createElement('canvas'); const maxW = 600; const sc = Math.min(1, maxW / cssW); out.width = Math.round(cssW * sc); out.height = Math.round(cssH * sc); out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height); const data = out.toDataURL('image/png'); state.sigData[f.id] = data; state.lastSig = data; }
    closeSheet(); afterChange(f);
  };
}

function openSheet() { document.getElementById('sheet').classList.add('show'); }
function closeSheet() { document.getElementById('sheet').classList.remove('show'); }
document.getElementById('sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

// ---- 검증 ----
function isFilled(f) {
  if (f.type === 'text') return !!(state.values[f.id] || '').toString().trim();
  if (f.type === 'date') return !!(state.values[f.id] || '').toString().trim();
  if (f.type === 'confirm') return !!(state.values[f.id] || '').trim() && normalize(state.values[f.id]) === normalize(f.answer);
  if (f.type === 'checkbox') return state.values[f.id] === true;
  if (f.type === 'radio') return !!state.values[f.grp] && state.fields.some(x => x.type === 'radio' && x.grp === f.grp && x.id === state.values[f.grp]);
  if (f.type === 'signature') return !!state.sigData[f.id];
  return true;
}
function revalidate() {
  const reqFields = state.fields.filter(f => f.required);
  const total = reqFields.length;
  const done = reqFields.filter(f => isFilled(f)).length;
  const ok = done >= total;
  const submitBtn = document.getElementById('submitBtn');
  const nextBtn = document.getElementById('nextBtn');
  const fill = document.getElementById('progFill');
  if (fill) fill.style.width = (total ? Math.round((done / total) * 100) : 100) + '%';
  const hint = document.getElementById('barHint');
  if (ok) {
    // 전부 완료 → 바가 "서명 완료" 버튼으로 전환
    if (nextBtn) nextBtn.classList.add('hidden');
    if (submitBtn) { submitBtn.classList.remove('hidden'); submitBtn.disabled = false; }
    if (hint) { hint.className = 'left ok'; hint.textContent = total ? `필수 ${done}/${total} · 확인 후 제출하세요` : '확인 후 제출하세요'; }
  } else {
    if (submitBtn) { submitBtn.classList.add('hidden'); submitBtn.disabled = true; }
    if (nextBtn) nextBtn.classList.remove('hidden');
    if (hint) { hint.className = 'left req'; hint.textContent = `필수 ${done}/${total}`; }
  }
}

// "다음 빈칸" → 첫 미작성 필수 필드로 이동
document.getElementById('nextBtn').addEventListener('click', () => {
  const nx = firstUnfilledRequired();
  if (nx) focusField(nx);
  else toast('필수 항목을 모두 작성했어요');
});

// ---- 제출 ----
document.getElementById('submitBtn').addEventListener('click', async () => {
  const btn = document.getElementById('submitBtn');
  btn.disabled = true; btn.textContent = '제출 중…';
  const signatures = {};
  state.fields.filter(f => f.type === 'signature').forEach(f => { if (state.sigData[f.id]) signatures[f.id] = state.sigData[f.id]; });
  const values = {};
  state.fields.forEach(f => { if (f.type !== 'signature' && f.type !== 'radio' && state.values[f.id] != null) values[f.id] = state.values[f.id]; });
  const grpsDone = new Set();
  state.fields.filter(f => f.type === 'radio' && f.grp).forEach(f => { if (grpsDone.has(f.grp)) return; grpsDone.add(f.grp); if (state.values[f.grp] != null) values[f.grp] = state.values[f.grp]; });

  try {
    const res = await fetch(`/api/f/${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values, signatures }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '제출 실패');
    document.getElementById('app').classList.add('hidden');
    document.getElementById('bar').classList.add('hidden');
    const dr = document.getElementById('doneRedo');
    if (!data.closed) { dr.classList.remove('hidden'); dr.textContent = '마감 전까지 같은 링크로 다시 수정할 수 있습니다.'; }
    document.getElementById('done').classList.remove('hidden');
    window.scrollTo(0, 0);
  } catch (e) { toast(e.message || '제출 실패'); btn.disabled = false; btn.textContent = '서명 완료'; revalidate(); }
});
