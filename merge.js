'use strict';

const {
  PDFDocument, rgb,
  pushGraphicsState, popGraphicsState,
  moveTo, lineTo, closePath, clip, endPath,
} = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

// 이름 가운데 마스킹 (홍길동→홍O동, 2글자 홍O)
function maskName(s) {
  s = (s || '').toString().trim();
  if (!s) return '';
  const a = [...s];
  if (a.length <= 1) return s;
  if (a.length === 2) return a[0] + 'O';
  return a[0] + 'O'.repeat(a.length - 2) + a[a.length - 1];
}

function drawCheck(page, bx, bw, bh, boxTopY, boxBottomY, color) {
  // 마크 크기 상한 14pt, 박스가 커도 정중앙에만 그림
  const s = Math.min(bw, bh, 14);
  const cxc = bx + bw / 2;          // 박스 가로 중앙
  const cyc = boxBottomY + bh / 2;  // 박스 세로 중앙
  const x1 = cxc - 0.38 * s, y1 = cyc + 0.00 * s;
  const x2 = cxc - 0.08 * s, y2 = cyc - 0.30 * s;
  const x3 = cxc + 0.40 * s, y3 = cyc + 0.34 * s;
  const lw = Math.max(1.2, s * 0.12);
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: lw, color });
  page.drawLine({ start: { x: x2, y: y2 }, end: { x: x3, y: y3 }, thickness: lw, color });
}

// opts: { pdfBytes, fontBytes, fields[], values{}, sigBuffers{}, footer{time,ip,docId} }
async function mergePdf(opts) {
  const { pdfBytes, fontBytes, fields, values, sigBuffers, footer } = opts;
  const pdf = await PDFDocument.load(pdfBytes);
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes, { subset: false });
  const pages = pdf.getPages();

  const embeddedSigs = {};
  for (const f of fields) {
    if (f.type === 'signature' && sigBuffers && sigBuffers[f.id]) {
      try { embeddedSigs[f.id] = await pdf.embedPng(sigBuffers[f.id]); } catch (e) {}
    }
  }

  for (const f of fields) {
    const page = pages[f.page];
    if (!page) continue;
    const { width: Wp, height: Hp } = page.getSize();
    const bx = f.x * Wp, bw = f.w * Wp, bh = f.h * Hp;
    const boxTopY = Hp - f.y * Hp;
    const boxBottomY = Hp - (f.y + f.h) * Hp;

    if (f.type === 'text' || f.type === 'confirm' || f.type === 'date') {
      const text = (values[f.id] || '').toString();
      if (!text) continue;
      const MIN = 4; // 최소 글자 크기(pt)
      const padX = Math.min(4, bw * 0.12); // 좌우 여백
      // 크기 결정: 박스 높이 기준에서 시작해, 폭·높이 양쪽에 맞을 때까지 축소(최소 4pt)
      let size = Math.min(13, Math.max(MIN, bh * 0.62));
      // 세로: 글자 전체 높이가 박스보다 크면 축소
      while (size > MIN && font.heightAtSize(size) > bh) size -= 0.5;
      // 가로: 글자 폭이 박스(좌우 여백 제외)보다 크면 축소
      let tw = font.widthOfTextAtSize(text, size);
      while (size > MIN && tw > bw - padX * 2) { size -= 0.5; tw = font.widthOfTextAtSize(text, size); }
      // 세로: 폰트 메트릭으로 박스 정중앙에 맞춤
      const ascent = font.heightAtSize(size, { descender: false });
      const full = font.heightAtSize(size);
      const descent = full - ascent;
      const cy = boxBottomY + (bh - (ascent + descent)) / 2 + descent;
      // 가로: 가운데 정렬 (넘치면 좌측 정렬 + 아래 클리핑으로 잘라냄)
      const cx = tw <= bw - padX * 2 ? bx + (bw - tw) / 2 : bx + padX;
      // 박스 영역으로 클리핑한 뒤 그려서 글자가 박스 밖으로 절대 안 나가게 함
      page.pushOperators(
        pushGraphicsState(),
        moveTo(bx, boxBottomY),
        lineTo(bx + bw, boxBottomY),
        lineTo(bx + bw, boxBottomY + bh),
        lineTo(bx, boxBottomY + bh),
        closePath(),
        clip(),
        endPath(),
      );
      page.drawText(text, { x: cx, y: cy, size, font, color: rgb(0.1, 0.12, 0.16) });
      page.pushOperators(popGraphicsState());

    } else if (f.type === 'checkbox') {
      if (values[f.id] !== true) continue;
      drawCheck(page, bx, bw, bh, boxTopY, boxBottomY, rgb(0.11, 0.48, 0.25));

    } else if (f.type === 'radio') {
      if (values[f.grp] !== f.id) continue;
      drawCheck(page, bx, bw, bh, boxTopY, boxBottomY, rgb(0.11, 0.32, 0.7));

    } else if (f.type === 'signature') {
      const img = embeddedSigs[f.id];
      if (!img) continue;
      // 박스 안쪽 여백(가로 88%·세로 76%)으로 비율유지 축소 후 가운데 배치
      const availW = bw * 0.88, availH = bh * 0.76;
      const scale = Math.min(availW / img.width, availH / img.height);
      const dw = img.width * scale, dh = img.height * scale;
      const dx = bx + (bw - dw) / 2;
      const dy = boxBottomY + (bh - dh) / 2;
      page.drawImage(img, { x: dx, y: dy, width: dw, height: dh });
    }
  }

  if (footer) {
    const last = pages[pages.length - 1];
    const { width: Wp } = last.getSize();
    const parts = [];
    if (footer.time) parts.push('제출 ' + footer.time);
    if (footer.ip) parts.push('IP ' + footer.ip);
    if (footer.docId) parts.push('문서 #' + String(footer.docId).slice(0, 8));
    parts.push('seokam-sign');
    const line = parts.join('  ·  ');
    last.drawLine({ start: { x: 28, y: 26 }, end: { x: Wp - 28, y: 26 }, thickness: 0.5, color: rgb(0.8, 0.83, 0.88) });
    last.drawText(line, { x: 28, y: 14, size: 7.5, font, color: rgb(0.55, 0.59, 0.65) });
  }

  return await pdf.save();
}

module.exports = { mergePdf, maskName };
