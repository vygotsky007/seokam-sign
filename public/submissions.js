'use strict';

const docId = new URLSearchParams(location.search).get('doc');
let toastTimer = null;
function toast(m) { const t = document.getElementById('toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2200); }
function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmt(iso) { if (!iso) return ''; const d = new Date(iso); const p = n => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} 제출`; }

const STATUS_KO = { open: '미작성', done: '작성됨', closed: '닫힘', expired: '만료' };

fetch('/api/health').then(r => r.json()).then(h => {
  const b = document.getElementById('storeBadge');
  if (h.store === 'supabase') { b.textContent = 'Supabase'; b.classList.add('supa'); }
  else { b.textContent = '로컬 폴백'; b.classList.add('local'); }
}).catch(() => {});

if (!docId) toast('문서 ID가 없습니다.');
else { document.getElementById('linksBtn').href = `/links.html?doc=${docId}`; load(); }

function getPin() { try { return sessionStorage.getItem('sign_admin_pin') || ''; } catch { return ''; } }
function setPin(v) { try { if (v) sessionStorage.setItem('sign_admin_pin', v); else sessionStorage.removeItem('sign_admin_pin'); } catch {} }

async function load() {
  try {
    const pin = getPin();
    const qs = pin ? `?pin=${encodeURIComponent(pin)}` : '';
    const res = await fetch(`/api/documents/${docId}/submissions${qs}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '로드 실패');
    document.getElementById('title').textContent = data.title || '문서';
    document.getElementById('stTotal').textContent = data.total;
    document.getElementById('stDone').textContent = data.done;
    document.getElementById('stOpen').textContent = data.total - data.done;
    renderMaskNote(data);
    renderRows(data.rows);
  } catch (e) { toast('오류: ' + e.message); }
}

// 마스킹 안내 + PIN 잠금해제(설정된 경우)
function renderMaskNote(data) {
  const sub = document.getElementById('docSub');
  if (data.pin_required && !data.authed) {
    sub.innerHTML = '이름은 <b>전체 마스킹(박○○)</b>으로 표시 중 · ' +
      '<button id="pinBtn" class="linkbtn" style="border:none;background:none;color:#2f6df4;cursor:pointer;padding:0;text-decoration:underline;font:inherit">🔒 PIN 입력하고 이름 더 보기</button>';
    const b = document.getElementById('pinBtn');
    if (b) b.addEventListener('click', () => {
      const v = prompt('관리자 PIN을 입력하세요');
      if (v == null) return;
      setPin(v.trim());
      load();
    });
  } else if (data.pin_required && data.authed) {
    sub.innerHTML = '이름은 <b>부분 마스킹(박○영)</b>으로 표시 중 · ' +
      '<button id="pinClr" class="linkbtn" style="border:none;background:none;color:#6b7686;cursor:pointer;padding:0;text-decoration:underline;font:inherit">잠금</button>';
    const c = document.getElementById('pinClr');
    if (c) c.addEventListener('click', () => { setPin(''); load(); });
  } else {
    sub.textContent = '이름은 제출한 보호자 성명에서 가져와 부분 마스킹 표시 · 미제출은 토큰만';
  }
}

function renderRows(rows) {
  const list = document.getElementById('list');
  list.innerHTML = '';
  if (!rows.length) { list.innerHTML = '<p class="sub">아직 생성된 링크가 없습니다.</p>'; return; }
  rows.forEach(r => {
    const row = document.createElement('div'); row.className = 'row';
    const who = r.done
      ? `<div class="nm">${esc(r.name || '(이름 없음)')}</div><div class="tm">${fmt(r.submitted_at)}</div>`
      : `<div class="nm muted">미제출</div><div class="tm">…/f/${esc(r.token)}</div>`;
    row.innerHTML =
      `<span class="seq">#${r.seq}</span>` +
      `<div class="who">${who}</div>` +
      `<span class="chip ${r.status}">${STATUS_KO[r.status]}</span>`;
    const pdfB = document.createElement('button'); pdfB.className = 'rbtn'; pdfB.textContent = 'PDF';
    pdfB.disabled = !r.done;
    pdfB.addEventListener('click', () => { window.open(`/api/links/${r.link_id}/merged.pdf?dl=1`, '_blank'); });
    const prB = document.createElement('button'); prB.className = 'rbtn'; prB.textContent = '인쇄';
    prB.disabled = !r.done;
    prB.addEventListener('click', () => {
      const w = window.open(`/api/links/${r.link_id}/merged.pdf`, '_blank');
      if (w) w.addEventListener('load', () => { try { w.print(); } catch (e) {} });
    });
    row.appendChild(pdfB); row.appendChild(prB);
    list.appendChild(row);
  });
}

document.getElementById('zipBtn').addEventListener('click', () => {
  window.location.href = `/api/documents/${docId}/merged.zip`;
});
document.getElementById('reload').addEventListener('click', load);
