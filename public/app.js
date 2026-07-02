'use strict';

const TYPE_META = {
  text:      { ko: '텍스트',     short: '텍스트',  answer: false },
  confirm:   { ko: '따라쓰기',   short: '따라',    answer: '정답 문구(학부모가 똑같이 따라 씀)' },
  checkbox:  { ko: '동의 체크',  short: '체크',    answer: '동의 문구(체크 옆 표시)' },
  signature: { ko: '손글씨 서명', short: '서명',   answer: false },
  date:      { ko: '날짜',       short: '날짜',    answer: false },
  radio:     { ko: '예/아니요',  short: '선택',    answer: false },
};

const TOOL_HINT = {
  select:    '박스를 클릭해 수정 · 드래그로 이동 · 모서리로 크기 조절',
  text:      '표는 칸마다 따로 그리세요',
  confirm:   '학부모가 똑같이 적을 문구 입력',
  checkbox:  '□ 위에 작게',
  signature: '서명란 크기에 맞춰, 학생·보호자 각각',
  date:      '자동/직접 선택 고르기',
  radio:     '같은 질문은 그룹 이름 똑같이(택1)',
};

const state = {
  docId: null,
  pdfDoc: null,
  pages: [],          // {wrap, overlay, w, h}
  fields: [],         // {id, page, x,y,w,h, type, label, required, answer}
  tool: 'select',
  selectedId: null,
};

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'f-' + Math.random().toString(36).slice(2) + Date.now());

function enableLinksBtn(docId) {
  const b = document.getElementById('linksBtn');
  b.disabled = false;
  // 링크 만들기 = ① 자동 저장 → ② 발급 전 확인 모달 → ③ 발급 화면
  b.onclick = async () => {
    const ok = await saveAll({ silent: true, skipIssuedNotice: true });
    if (!ok) return; // 저장 실패(예: 따라쓰기 문구 미입력)면 중단
    openIssueModal();
  };
}

// ---------------------------------------------------------------------------
// 저장소 배지
// ---------------------------------------------------------------------------
fetch('/api/health').then(r => r.json()).then(h => {
  const b = document.getElementById('storeBadge');
  if (h.store === 'supabase') { b.textContent = 'Supabase'; b.classList.add('supa'); }
  else { b.textContent = '로컬 폴백'; b.classList.add('local'); }
}).catch(() => {});

// ---------------------------------------------------------------------------
// 업로드 (드래그&드롭 + 선택)
// ---------------------------------------------------------------------------
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, e => {
  e.preventDefault(); dropZone.classList.add('drag');
}));
['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, e => {
  e.preventDefault(); dropZone.classList.remove('drag');
}));
dropZone.addEventListener('drop', e => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleUpload(f);
});
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleUpload(fileInput.files[0]); });

async function handleUpload(file) {
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { toast('PDF 파일만 가능합니다.'); return; }
  if (file.size > 32 * 1024 * 1024) { toast('파일이 너무 큽니다 (최대 32MB).'); return; }

  const titleEl = document.getElementById('docTitle');
  if (!titleEl.value.trim()) titleEl.value = file.name.replace(/\.pdf$/i, '');

  document.getElementById('uploadInfo').textContent = '업로드 중…';
  const fd = new FormData();
  fd.append('pdf', file);
  fd.append('title', titleEl.value.trim());

  try {
    const res = await fetch('/api/documents', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '업로드 실패');
    state.docId = data.id;
    state.fields = [];
    document.getElementById('uploadInfo').innerHTML =
      `업로드 완료 · 문서ID <code>${data.id.slice(0, 8)}</code><br>링크 복원: <a href="?doc=${data.id}">?doc=${data.id.slice(0,8)}</a>`;
    document.getElementById('saveBtn').disabled = false;
    history.replaceState(null, '', `?doc=${data.id}`);
    enableLinksBtn(data.id);
    await renderPdf(`/api/documents/${data.id}/pdf`);
    refreshFieldList();
    toast('PDF 업로드 완료');
  } catch (e) {
    document.getElementById('uploadInfo').textContent = '';
    toast('오류: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// PDF 렌더 (여러 페이지)
// ---------------------------------------------------------------------------
async function renderPdf(url) {
  document.getElementById('empty').classList.add('hidden');
  const pagesEl = document.getElementById('pages');
  pagesEl.innerHTML = '';
  state.pages = [];

  const loadingTask = pdfjsLib.getDocument(url);
  state.pdfDoc = await loadingTask.promise;

  const stageW = document.getElementById('stage').clientWidth - 44;
  const targetW = Math.min(820, Math.max(420, stageW));

  for (let p = 1; p <= state.pdfDoc.numPages; p++) {
    const page = await state.pdfDoc.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const scale = targetW / base.width;
    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;

    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.style.width = viewport.width + 'px';
    wrap.style.height = viewport.height + 'px';

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    wrap.appendChild(canvas);
    wrap.appendChild(overlay);
    pagesEl.appendChild(wrap);

    await page.render({ canvasContext: ctx, viewport }).promise;

    const idx = p - 1;
    state.pages[idx] = { wrap, overlay, w: viewport.width, h: viewport.height };
    attachPlacement(overlay, idx);
  }
  renderAllFields();
}

// ---------------------------------------------------------------------------
// 팔레트 (도구 선택)
// ---------------------------------------------------------------------------
document.querySelectorAll('.tool[data-type]').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.type));
});
document.getElementById('selectMode').addEventListener('click', () => setTool('select'));

function setTool(t) {
  state.tool = t;
  document.querySelectorAll('.tool').forEach(b => b.classList.remove('active'));
  if (t === 'select') document.getElementById('selectMode').classList.add('active');
  else document.querySelector(`.tool[data-type="${t}"]`).classList.add('active');
  document.getElementById('stage').classList.toggle('placing', t !== 'select');
  const hintEl = document.getElementById('toolHint');
  if (hintEl && TOOL_HINT[t]) hintEl.textContent = TOOL_HINT[t];
}

// ---------------------------------------------------------------------------
// 드래그로 영역 생성 (placing)
// ---------------------------------------------------------------------------
function attachPlacement(overlay, pageIdx) {
  overlay.addEventListener('pointerdown', e => {
    if (state.tool === 'select') return;
    if (e.target !== overlay) return; // 기존 박스 위는 무시
    e.preventDefault();
    const rect = overlay.getBoundingClientRect();
    const startX = e.clientX - rect.left;
    const startY = e.clientY - rect.top;

    const ghost = document.createElement('div');
    ghost.className = 'fieldbox';
    ghost.style.left = startX + 'px'; ghost.style.top = startY + 'px';
    ghost.style.width = '0px'; ghost.style.height = '0px';
    overlay.appendChild(ghost);

    const move = ev => {
      const cx = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
      const cy = Math.max(0, Math.min(rect.height, ev.clientY - rect.top));
      ghost.style.left = Math.min(startX, cx) + 'px';
      ghost.style.top = Math.min(startY, cy) + 'px';
      ghost.style.width = Math.abs(cx - startX) + 'px';
      ghost.style.height = Math.abs(cy - startY) + 'px';
    };
    const up = ev => {
      overlay.removeEventListener('pointermove', move);
      overlay.removeEventListener('pointerup', up);
      const W = parseFloat(ghost.style.width), H = parseFloat(ghost.style.height);
      const L = parseFloat(ghost.style.left), T = parseFloat(ghost.style.top);
      ghost.remove();
      if (W < 14 || H < 12) { return; } // 너무 작으면 취소
      const pg = state.pages[pageIdx];
      const field = {
        id: uid(), page: pageIdx,
        x: L / pg.w, y: T / pg.h, w: W / pg.w, h: H / pg.h,
        type: state.tool,
        label: defaultLabel(state.tool),
        required: true,
        answer: state.tool === 'date' ? 'auto' : (TYPE_META[state.tool].answer ? '' : null),
        grp: state.tool === 'radio' ? (state.lastGrp || '선택1') : null,
      };
      state.fields.push(field);
      renderAllFields();
      refreshFieldList();
      openEditor(field.id);
    };
    overlay.setPointerCapture(e.pointerId);
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerup', up);
  });
}

function defaultLabel(type) {
  return { text: '텍스트 입력', confirm: '따라쓰기', checkbox: '동의합니다', signature: '서명', date: '날짜', radio: '예' }[type] || '필드';
}

// ---------------------------------------------------------------------------
// 필드 박스 렌더
// ---------------------------------------------------------------------------
function renderAllFields() {
  state.pages.forEach(pg => { if (pg) pg.overlay.querySelectorAll('.fieldbox').forEach(n => n.remove()); });
  state.fields.forEach(f => renderField(f));
}

function renderField(f) {
  const pg = state.pages[f.page];
  if (!pg) return;
  const box = document.createElement('div');
  box.className = 'fieldbox' + (f.required ? ' required' : '') + (state.selectedId === f.id ? ' selected' : '');
  box.dataset.id = f.id;
  positionBox(box, f, pg);

  const label = document.createElement('div');
  label.className = 'fb-label';
  label.textContent = `${f.label} · ${TYPE_META[f.type].short}` + (f.type === 'radio' && f.grp ? ` [${f.grp}]` : '');
  box.appendChild(label);

  const typeTag = document.createElement('div');
  typeTag.className = 'fb-type';
  typeTag.textContent = TYPE_META[f.type].short;
  box.appendChild(typeTag);

  const del = document.createElement('button');
  del.className = 'fb-del'; del.textContent = '×';
  del.addEventListener('pointerdown', e => e.stopPropagation());
  del.addEventListener('click', e => { e.stopPropagation(); removeField(f.id); });
  box.appendChild(del);

  const handle = document.createElement('div');
  handle.className = 'fb-handle';
  box.appendChild(handle);

  enableDrag(box, f, pg, handle);
  pg.overlay.appendChild(box);
}

function positionBox(box, f, pg) {
  box.style.left = (f.x * pg.w) + 'px';
  box.style.top = (f.y * pg.h) + 'px';
  box.style.width = (f.w * pg.w) + 'px';
  box.style.height = (f.h * pg.h) + 'px';
}

// 이동 + 리사이즈 (포인터 = 터치/마우스 공용)
function enableDrag(box, f, pg, handle) {
  let mode = null, sx = 0, sy = 0, ox = 0, oy = 0, ow = 0, oh = 0, moved = false;

  const start = (e, m) => {
    e.preventDefault(); e.stopPropagation();
    mode = m; moved = false;
    sx = e.clientX; sy = e.clientY;
    ox = f.x * pg.w; oy = f.y * pg.h; ow = f.w * pg.w; oh = f.h * pg.h;
    box.setPointerCapture(e.pointerId);
    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', onUp);
  };
  const onMove = e => {
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
    if (mode === 'move') {
      let nx = Math.max(0, Math.min(pg.w - ow, ox + dx));
      let ny = Math.max(0, Math.min(pg.h - oh, oy + dy));
      f.x = nx / pg.w; f.y = ny / pg.h;
    } else { // resize
      let nw = Math.max(14, Math.min(pg.w - ox, ow + dx));
      let nh = Math.max(12, Math.min(pg.h - oy, oh + dy));
      f.w = nw / pg.w; f.h = nh / pg.h;
    }
    positionBox(box, f, pg);
  };
  const onUp = e => {
    box.removeEventListener('pointermove', onMove);
    box.removeEventListener('pointerup', onUp);
    if (!moved && mode === 'move') openEditor(f.id);
    mode = null;
  };

  box.addEventListener('pointerdown', e => { if (e.target === handle) return; start(e, 'move'); });
  handle.addEventListener('pointerdown', e => start(e, 'resize'));
}

function removeField(id) {
  state.fields = state.fields.filter(f => f.id !== id);
  if (state.selectedId === id) closeEditor();
  renderAllFields(); refreshFieldList();
}

// ---------------------------------------------------------------------------
// 편집 팝오버
// ---------------------------------------------------------------------------
const editor = document.getElementById('editor');
function openEditor(id) {
  const f = state.fields.find(x => x.id === id);
  if (!f) return;
  state.selectedId = id;
  renderAllFields();

  document.getElementById('edLabel').value = f.label;
  const meta = TYPE_META[f.type];
  const aRow = document.getElementById('edAnswerRow');
  if (meta.answer) {
    aRow.style.display = '';
    document.getElementById('edAnswerLabel').textContent = meta.answer;
    document.getElementById('edAnswer').value = f.answer || '';
  } else aRow.style.display = 'none';

  // 날짜 입력 방식
  const dRow = document.getElementById('edDateRow');
  if (f.type === 'date') { dRow.style.display = ''; document.getElementById('edDateMode').value = f.answer || 'auto'; }
  else dRow.style.display = 'none';

  // 라디오 그룹
  const gRow = document.getElementById('edGrpRow');
  if (f.type === 'radio') { gRow.style.display = ''; document.getElementById('edGrp').value = f.grp || ''; }
  else gRow.style.display = 'none';

  document.getElementById('edRequired').checked = !!f.required;

  // 위치: 박스 근처
  const pg = state.pages[f.page];
  const r = pg.wrap.getBoundingClientRect();
  let left = r.left + f.x * pg.w + f.w * pg.w + 12;
  let top = r.top + f.y * pg.h;
  if (left + 260 > window.innerWidth) left = r.left + f.x * pg.w - 262;
  top = Math.max(70, Math.min(window.innerHeight - 220, top));
  editor.style.left = Math.max(10, left) + 'px';
  editor.style.top = top + 'px';
  editor.classList.remove('hidden');
}
function closeEditor() {
  editor.classList.add('hidden');
  state.selectedId = null;
  renderAllFields();
}
document.getElementById('edLabel').addEventListener('input', e => {
  const f = cur(); if (f) { f.label = e.target.value; renderAllFields(); refreshFieldList(); }
});
document.getElementById('edAnswer').addEventListener('input', e => {
  const f = cur(); if (f) f.answer = e.target.value;
});
document.getElementById('edDateMode').addEventListener('change', e => {
  const f = cur(); if (f) f.answer = e.target.value;
});
document.getElementById('edGrp').addEventListener('input', e => {
  const f = cur(); if (f) { f.grp = e.target.value; state.lastGrp = e.target.value; renderAllFields(); refreshFieldList(); }
});
document.getElementById('edRequired').addEventListener('change', e => {
  const f = cur(); if (f) { f.required = e.target.checked; renderAllFields(); refreshFieldList(); }
});
document.getElementById('edDelete').addEventListener('click', () => { const f = cur(); if (f) removeField(f.id); });
document.getElementById('edClose').addEventListener('click', closeEditor);
function cur() { return state.fields.find(x => x.id === state.selectedId); }

// ---------------------------------------------------------------------------
// 필드 목록 (사이드바)
// ---------------------------------------------------------------------------
function refreshFieldList() {
  const ul = document.getElementById('fieldList');
  document.getElementById('fieldCount').textContent = state.fields.length;
  ul.innerHTML = '';
  state.fields.forEach((f, i) => {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="req-dot ${f.required ? '' : 'opt'}"></span>` +
      `<span class="fl-label">${escapeHtml(f.label)}</span>` +
      `<span class="tag">${TYPE_META[f.type].short}</span>` +
      `<span class="tag">p${f.page + 1}</span>`;
    li.addEventListener('click', () => {
      const pg = state.pages[f.page];
      if (pg) pg.wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
      openEditor(f.id);
    });
    ul.appendChild(li);
  });
}
function escapeHtml(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------------------------------------------------------------------------
// 저장
// ---------------------------------------------------------------------------
// 따라쓰기(confirm) 문구가 비어 있는 첫 필드 (있으면 저장 불가)
function firstEmptyConfirm() {
  return state.fields.find(f => f.type === 'confirm' && !((f.answer || '').toString().trim()));
}

// 저장 통합 로직 — 저장 버튼과 "링크 만들기(자동 저장)"가 함께 사용.
async function saveAll(opts = {}) {
  if (!state.docId) { toast('먼저 PDF를 업로드하세요.'); return false; }
  const bad = firstEmptyConfirm();
  if (bad) { toast('따라쓰기 필드의 문구를 입력해야 저장돼요.'); openEditor(bad.id); return false; }
  const payload = {
    fields: state.fields.map((f, i) => ({
      id: f.id, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h,
      type: f.type, label: f.label, required: f.required,
      answer: f.answer, grp: f.grp || null, sort: i,
    })),
  };
  try {
    const res = await fetch(`/api/documents/${state.docId}/fields`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '저장 실패');
    await fetch(`/api/documents/${state.docId}/meta`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memo: document.getElementById('memo').value }),
    });
    if (!opts.silent) {
      // 발급 후 수정 정책 안내: 발급 링크가 있으면 함께 알림.
      let issued = 0;
      if (!opts.skipIssuedNotice) {
        try { const lr = await fetch(`/api/documents/${state.docId}/links`); const lj = await lr.json(); issued = (lj.links || []).length; } catch {}
      }
      toast(issued > 0
        ? `저장 완료 · 필드 ${data.count}개 · 발급 링크 ${issued}개 있음 — 미작성자에게는 수정본이 보입니다`
        : `저장 완료 · 필드 ${data.count}개`);
    }
    return true;
  } catch (e) { toast('오류: ' + e.message); return false; }
}

document.getElementById('saveBtn').addEventListener('click', () => saveAll());

// ---------------------------------------------------------------------------
// 발급 전 검증 + 확인 모달 + 최종 미리보기
// ---------------------------------------------------------------------------
function validateForIssue() {
  const blocks = [], warns = [];
  const fieldCount = state.fields.length;
  const requiredCount = state.fields.filter(f => f.required).length;
  if (fieldCount === 0) blocks.push('필드가 없습니다. 최소 1개 이상 추가하세요.');
  state.fields.filter(f => f.type === 'confirm' && !((f.answer || '').toString().trim()))
    .forEach(f => blocks.push(`따라쓰기 "${f.label || '(제목 없음)'}"의 문구가 비어 있어요.`));
  const grpCount = {};
  state.fields.filter(f => f.type === 'radio').forEach(f => {
    const g = (f.grp || '(그룹 미지정)'); grpCount[g] = (grpCount[g] || 0) + 1;
  });
  Object.entries(grpCount).forEach(([g, c]) => {
    if (c < 2) blocks.push(`선택 그룹 "${g}"에 선택지가 1개뿐이에요. (택1은 2개 이상 필요)`);
  });
  if (requiredCount === 0) warns.push('필수로 지정된 항목이 하나도 없어요. 이대로 발급하면 빈 제출도 가능합니다.');
  return { fieldCount, requiredCount, blocks, warns };
}

async function renderIssuePreview(container) {
  container.innerHTML = '<div class="pv-loading">미리보기 준비 중…</div>';
  if (!state.pdfDoc) { container.innerHTML = '<div class="pv-loading">PDF가 없어 미리보기를 만들 수 없어요.</div>'; return; }
  container.innerHTML = '';
  const p = n => String(n).padStart(2, '0');
  const d = new Date();
  const todayS = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const sampleGrp = {}; // 그룹별 첫 옵션만 선택 표시
  state.fields.filter(f => f.type === 'radio').forEach(f => { const g = f.grp || ''; if (!(g in sampleGrp)) sampleGrp[g] = f.id; });
  for (let pi = 1; pi <= state.pdfDoc.numPages; pi++) {
    const page = await state.pdfDoc.getPage(pi);
    const base = page.getViewport({ scale: 1 });
    const targetW = Math.min(340, (container.clientWidth || 340));
    const scale = targetW / base.width;
    const vp = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    const wrap = document.createElement('div'); wrap.className = 'pv-page';
    wrap.style.width = vp.width + 'px'; wrap.style.height = vp.height + 'px';
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    wrap.appendChild(canvas); container.appendChild(wrap);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    state.fields.filter(f => f.page === pi - 1).forEach(f => {
      const el = document.createElement('div'); el.className = 'pv-val';
      el.style.left = (f.x * vp.width) + 'px'; el.style.top = (f.y * vp.height) + 'px';
      el.style.width = (f.w * vp.width) + 'px'; el.style.height = (f.h * vp.height) + 'px';
      let txt = '';
      if (f.type === 'text') txt = '홍길동';
      else if (f.type === 'confirm') txt = f.answer || '(문구)';
      else if (f.type === 'checkbox') txt = '✓';
      else if (f.type === 'signature') txt = '(서명)';
      else if (f.type === 'date') txt = todayS;
      else if (f.type === 'radio') txt = (sampleGrp[f.grp || ''] === f.id) ? '●' : '○';
      el.textContent = txt;
      wrap.appendChild(el);
    });
  }
}

function openIssueModal() {
  const v = validateForIssue();
  document.getElementById('issueSummary').innerHTML = `필드 <b>${v.fieldCount}</b>개 · 필수 <b>${v.requiredCount}</b>개`;
  const blocksEl = document.getElementById('issueBlocks');
  blocksEl.innerHTML = v.blocks.length
    ? '<div class="ib-title bad">🚫 발급 전 수정이 필요해요</div>' + v.blocks.map(b => `<div class="ib bad">• ${escapeHtml(b)}</div>`).join('')
    : '<div class="ib-title ok">✓ 발급 가능한 상태예요</div>';
  const warnsEl = document.getElementById('issueWarns');
  warnsEl.innerHTML = v.warns.length
    ? '<div class="ib-title warn">⚠ 확인만 해주세요</div>' + v.warns.map(w => `<div class="ib warn">• ${escapeHtml(w)}</div>`).join('')
    : '';
  const go = document.getElementById('issueGo');
  const fix = document.getElementById('issueFix');
  if (v.blocks.length) { go.disabled = true; fix.classList.remove('hidden'); }
  else { go.disabled = false; fix.classList.add('hidden'); }
  document.getElementById('issueModal').classList.remove('hidden');
  renderIssuePreview(document.getElementById('issuePreview'));
}
function closeIssueModal() { document.getElementById('issueModal').classList.add('hidden'); }
document.getElementById('issueClose').addEventListener('click', closeIssueModal);
document.getElementById('issueFix').addEventListener('click', closeIssueModal);
document.getElementById('issueGo').addEventListener('click', () => {
  if (!state.docId) return;
  location.href = `/links.html?doc=${state.docId}`;
});
document.getElementById('issueModal').addEventListener('click', (e) => {
  if (e.target.id === 'issueModal') closeIssueModal();
});

// ---------------------------------------------------------------------------
// 복원 (?doc=ID 로 진입 시)
// ---------------------------------------------------------------------------
async function restoreFromQuery() {
  const id = new URLSearchParams(location.search).get('doc');
  if (!id) return;
  try {
    const res = await fetch(`/api/documents/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '복원 실패');
    state.docId = id;
    document.getElementById('docTitle').value = data.document.title || '';
    document.getElementById('memo').value = data.document.memo || '';
    document.getElementById('saveBtn').disabled = false;
    enableLinksBtn(id);
    document.getElementById('uploadInfo').innerHTML = `복원됨 · <code>${id.slice(0, 8)}</code>`;
    await renderPdf(`/api/documents/${id}/pdf`);
    state.fields = (data.fields || []).map(f => ({
      id: f.id, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h,
      type: f.type, label: f.label, required: f.required, answer: f.answer, grp: f.grp || null,
    }));
    renderAllFields(); refreshFieldList();
    toast(`문서 복원 · 필드 ${state.fields.length}개`);
  } catch (e) { toast('복원 오류: ' + e.message); }
}

window.addEventListener('click', e => {
  if (!editor.classList.contains('hidden') &&
      !editor.contains(e.target) &&
      !e.target.closest('.fieldbox') &&
      !e.target.closest('.field-list')) {
    closeEditor();
  }
});

restoreFromQuery();
