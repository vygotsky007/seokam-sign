'use strict';

const { PDFDocument, rgb } = require('pdf-lib');
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
  const pad = Math.min(bw, bh) * 0.2;
  const x1 = bx + pad, y1 = boxBottomY + bh * 0.45;
  const x2 = bx + bw * 0.42, y2 = boxBottomY + pad;
  const x3 = bx + bw - pad, y3 = boxTopY - pad;
  const lw = Math.max(1.2, Math.min(bw, bh) * 0.1);
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
      let size = Math.min(13, Math.max(8, bh * 0.62));
      let tw = font.widthOfTextAtSize(text, size);
      while (tw > bw - 4 && size > 7) { size -= 0.5; tw = font.widthOfTextAtSize(text, size); }
      // 세로: 폰트 메트릭으로 박스 정중앙에 맞춤
      const ascent = font.heightAtSize(size, { descender: false });
      const full = font.heightAtSize(size);
      const descent = full - ascent;
      const cy = boxBottomY + (bh - (ascent + descent)) / 2 + descent;
      // 가로: 가운데 정렬 (넘치면 좌측 정렬)
      const cx = tw < bw - 4 ? bx + (bw - tw) / 2 : bx + 2;
      page.drawText(text, { x: cx, y: cy, size, font, color: rgb(0.1, 0.12, 0.16) });

    } else if (f.type === 'checkbox') {
      if (values[f.id] !== true) continue;
      drawCheck(page, bx, bw, bh, boxTopY, boxBottomY, rgb(0.11, 0.48, 0.25));

    } else if (f.type === 'radio') {
      if (values[f.grp] !== f.id) continue;
      drawCheck(page, bx, bw, bh, boxTopY, boxBottomY, rgb(0.11, 0.32, 0.7));

    } else if (f.type === 'signature') {
      const img = embeddedSigs[f.id];
      if (!img) continue;
      const scale = Math.min(bw / img.width, bh / img.height);
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
