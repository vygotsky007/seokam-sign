'use strict';

const TOKEN = decodeURIComponent((location.pathname.match(/\/f\/([^/]+)/) || [])[1] || '');
const state = { fields: [], values: {}, sigs: {}, sigPads: {} };

let toastTimer = null;
function toast(m) {
  const t = document.getElementById('toast');
  t.textContent = m; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}
function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function normalize(s) { return (s || '').toString().replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase(); }
function fmtDate(iso) { const d = new Date(iso); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }

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
    if (data.has_response) document.getElementById('redo').classList.remove('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('bar').classList.remove('hidden');
    await renderPdf();
    renderForm();
    revalidate();
  } catch (e) { showBlocked('error'); }
}

function showBlocked(reason, title) {
  document.getElementById('blockedMsg').textContent = BLOCK_MSG[reason] || BLOCK_MSG.error;
  if (title) document.getElementById('blockedTitle').textContent = title;
  document.getElementById('blocked').classList.remove('hidden');
}

// ---- PDF 미리보기 (읽기전용 + 필드 위치 표시) ----
async function renderPdf() {
  const pagesEl = document.getElementById('pages');
  try {
    const pdf = await pdfjsLib.getDocument(`/api/f/${TOKEN}/pdf`).promise;
    const targetW = Math.min(408, document.querySelector('.pdfwrap').clientWidth - 20);
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const base = page.getViewport({ scale: 1 });
      const scale = targetW / base.width;
      const vp = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const wrap = document.createElement('div');
      wrap.className = 'page-wrap'; wrap.style.width = vp.width + 'px'; wrap.style.height = vp.height + 'px';
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
      const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
      const ov = document.createElement('div'); ov.className = 'ov';
      wrap.appendChild(canvas); wrap.appendChild(ov); pagesEl.appendChild(wrap);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      state.fields.forEach((f, i) => {
        if (f.page !== p - 1) return;
        const b = document.createElement('div');
        b.className = 'fbox' + (f.required ? ' req' : '');
        b.style.left = (f.x * vp.width) + 'px'; b.style.top = (f.y * vp.height) + 'px';
        b.style.width = (f.w * vp.width) + 'px'; b.style.height = (f.h * vp.height) + 'px';
        b.innerHTML = `<span class="num">${i + 1}</span>`;
        ov.appendChild(b);
      });
    }
  } catch (e) {
    document.getElementById('pdfcap').textContent = '미리보기를 불러오지 못했습니다 (작성은 가능합니다)';
  }
}

// ---- 작성 폼 ----
function renderForm() {
  const box = document.getElementById('form');
  box.innerHTML = '';
  state.fields.forEach((f, i) => {
    const wrap = document.createElement('div'); wrap.className = 'field';
    const star = f.required ? '<span class="star">*</span> ' : '';
    const label = `<div class="flabel"><span class="n">${i + 1}</span> ${star}${esc(f.label)}</div>`;

    if (f.type === 'text') {
      wrap.innerHTML = label + `<input type="text" data-id="${f.id}" placeholder="입력" value="${esc(state.values[f.id] || '')}" />`;
      wrap.querySelector('input').addEventListener('input', e => { state.values[f.id] = e.target.value; revalidate(); });

    } else if (f.type === 'confirm') {
      wrap.innerHTML = label +
        `<div class="copytarget">"${esc(f.answer || '')}"</div>` +
        `<input type="text" data-id="${f.id}" placeholder="위 문구를 그대로 따라 적어주세요" value="${esc(state.values[f.id] || '')}" />` +
        `<div class="match no" data-match="${f.id}">공백·기호는 무시하고 글자만 맞으면 됩니다</div>`;
      const inp = wrap.querySelector('input');
      inp.addEventListener('input', e => { state.values[f.id] = e.target.value; updateMatch(f); revalidate(); });
      setTimeout(() => updateMatch(f), 0);

    } else if (f.type === 'checkbox') {
      const checked = state.values[f.id] === true ? 'checked' : '';
      wrap.innerHTML = `<label class="chk"><input type="checkbox" data-id="${f.id}" ${checked}/> <span>${star}${esc(f.label)}</span></label>`;
      wrap.querySelector('input').addEventListener('change', e => { state.values[f.id] = e.target.checked; revalidate(); });

    } else if (f.type === 'signature') {
      wrap.innerHTML = label +
        `<div class="sigbox"><canvas data-id="${f.id}"></canvas>` +
        `<button type="button" class="clr" data-clr="${f.id}">지우기</button>` +
        `<div class="ph" data-ph="${f.id}">여기에 손가락으로 서명</div></div>`;
      box.appendChild(wrap);
      setupSignature(f, wrap);
      return;
    }
    box.appendChild(wrap);
  });

  // 기존 서명 미리보기 (재작성)
  state.fields.filter(f => f.type === 'signature').forEach(f => {
    if (typeof state.values[f.id] === 'string' && state.values[f.id].startsWith('responses/')) {
      const img = new Image();
      img.onload = () => {
        const pad = state.sigPads[f.id]; if (!pad) return;
        pad.ctx.drawImage(img, 0, 0, pad.canvas.width / pad.dpr, pad.canvas.height / pad.dpr);
        pad.dirty = true; hidePh(f.id); revalidate();
      };
      img.src = `/api/f/${TOKEN}/sig/${f.id}?t=${Date.now()}`;
    }
  });
}

function updateMatch(f) {
  const el = document.querySelector(`[data-match="${f.id}"]`);
  if (!el) return;
  const v = state.values[f.id] || '';
  if (!v.trim()) { el.className = 'match no'; el.textContent = '공백·기호는 무시하고 글자만 맞으면 됩니다'; return; }
  if (normalize(v) === normalize(f.answer)) { el.className = 'match ok'; el.textContent = '✓ 일치합니다'; }
  else { el.className = 'match no'; el.textContent = '아직 문구와 다릅니다'; }
}

// ---- 손글씨 서명 ----
function setupSignature(f, wrap) {
  const canvas = wrap.querySelector('canvas');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssW = rect.width || 360, cssH = 150;
  canvas.width = Math.floor(cssW * dpr); canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1a2230';
  const pad = { canvas, ctx, dpr, drawing: false, dirty: false, last: null };
  state.sigPads[f.id] = pad;

  const pos = e => {
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  };
  const start = e => { e.preventDefault(); pad.drawing = true; pad.last = pos(e); hidePh(f.id); };
  const move = e => {
    if (!pad.drawing) return; e.preventDefault();
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(pad.last.x, pad.last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    pad.last = p; pad.dirty = true;
  };
  const end = () => { if (pad.drawing) { pad.drawing = false; revalidate(); } };

  canvas.addEventListener('pointerdown', start);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointerleave', end);

  wrap.querySelector(`[data-clr="${f.id}"]`).addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height); pad.dirty = false;
    showPh(f.id); revalidate();
  });
}
function hidePh(id) { const e = document.querySelector(`[data-ph="${id}"]`); if (e) e.style.display = 'none'; }
function showPh(id) { const e = document.querySelector(`[data-ph="${id}"]`); if (e) e.style.display = 'flex'; }

// 서명 PNG 추출 (최대 폭 600으로 축소·압축)
function exportSig(f) {
  const pad = state.sigPads[f.id];
  if (!pad || !pad.dirty) return null;
  const cssW = pad.canvas.width / pad.dpr, cssH = pad.canvas.height / pad.dpr;
  const maxW = 600, scale = Math.min(1, maxW / cssW);
  const out = document.createElement('canvas');
  out.width = Math.round(cssW * scale); out.height = Math.round(cssH * scale);
  const octx = out.getContext('2d');
  octx.drawImage(pad.canvas, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

// ---- 검증 ----
function isFilled(f) {
  if (f.type === 'text') return !!(state.values[f.id] || '').toString().trim();
  if (f.type === 'confirm') return normalize(state.values[f.id]) === normalize(f.answer) && !!(state.values[f.id] || '').trim();
  if (f.type === 'checkbox') return state.values[f.id] === true;
  if (f.type === 'signature') { const p = state.sigPads[f.id]; return !!(p && p.dirty); }
  return true;
}
function revalidate() {
  const ok = state.fields.filter(f => f.required).every(isFilled);
  document.getElementById('submitBtn').disabled = !ok;
  document.getElementById('barHint').textContent = ok ? '확인 후 서명 완료를 눌러주세요' : '필수 항목(*)을 모두 채우면 제출할 수 있어요';
}

// ---- 제출 ----
document.getElementById('submitBtn').addEventListener('click', async () => {
  const btn = document.getElementById('submitBtn');
  btn.disabled = true; btn.textContent = '제출 중…';
  const signatures = {};
  state.fields.filter(f => f.type === 'signature').forEach(f => { const d = exportSig(f); if (d) signatures[f.id] = d; });
  const values = {};
  state.fields.forEach(f => { if (f.type !== 'signature' && state.values[f.id] != null) values[f.id] = state.values[f.id]; });

  try {
    const res = await fetch(`/api/f/${TOKEN}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values, signatures }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '제출 실패');
    document.getElementById('app').classList.add('hidden');
    document.getElementById('bar').classList.add('hidden');
    const dr = document.getElementById('doneRedo');
    if (!data.closed) { dr.classList.remove('hidden'); dr.textContent = '마감 전까지 같은 링크로 다시 수정할 수 있습니다.'; }
    document.getElementById('done').classList.remove('hidden');
    window.scrollTo(0, 0);
  } catch (e) {
    toast(e.message || '제출 실패');
    btn.disabled = false; btn.textContent = '서명 완료'; revalidate();
  }
});
