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

// 비율좌표(좌상단 기준) + 값으로 PDF 합성
// opts: { pdfBytes(Buffer), fontBytes(Buffer), fields[], values{}, sigBuffers{fieldId:Buffer} }
async function mergePdf(opts) {
  const { pdfBytes, fontBytes, fields, values, sigBuffers } = opts;
  const pdf = await PDFDocument.load(pdfBytes);
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes, { subset: false });
  const pages = pdf.getPages();

  // 서명 이미지 미리 embed (필드별)
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
    const bx = f.x * Wp;
    const bw = f.w * Wp;
    const bh = f.h * Hp;
    const boxTopY = Hp - f.y * Hp;        // 박스 상단 (아래 기준)
    const boxBottomY = Hp - (f.y + f.h) * Hp; // 박스 하단

    if (f.type === 'text' || f.type === 'confirm') {
      const text = (values[f.id] || '').toString();
      if (!text) continue;
      let size = Math.min(13, Math.max(8, bh * 0.6));
      // 폭 넘치면 축소
      let tw = font.widthOfTextAtSize(text, size);
      while (tw > bw - 4 && size > 7) { size -= 0.5; tw = font.widthOfTextAtSize(text, size); }
      const cy = (boxTopY + boxBottomY) / 2 - size * 0.35;
      page.drawText(text, { x: bx + 2, y: cy, size, font, color: rgb(0.1, 0.12, 0.16) });

    } else if (f.type === 'checkbox') {
      if (values[f.id] !== true) continue;
      // ✓ 벡터로 직접 (폰트 의존 X)
      const pad = Math.min(bw, bh) * 0.2;
      const x1 = bx + pad, y1 = boxBottomY + bh * 0.45;
      const x2 = bx + bw * 0.42, y2 = boxBottomY + pad;
      const x3 = bx + bw - pad, y3 = boxTopY - pad;
      const lw = Math.max(1.2, Math.min(bw, bh) * 0.1);
      page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: lw, color: rgb(0.11, 0.48, 0.25) });
      page.drawLine({ start: { x: x2, y: y2 }, end: { x: x3, y: y3 }, thickness: lw, color: rgb(0.11, 0.48, 0.25) });

    } else if (f.type === 'signature') {
      const img = embeddedSigs[f.id];
      if (!img) continue;
      // 박스 안에 비율 유지하여 맞춤
      const scale = Math.min(bw / img.width, bh / img.height);
      const dw = img.width * scale, dh = img.height * scale;
      const dx = bx + (bw - dw) / 2;
      const dy = boxBottomY + (bh - dh) / 2;
      page.drawImage(img, { x: dx, y: dy, width: dw, height: dh });
    }
  }

  return await pdf.save();
}

module.exports = { mergePdf, maskName };
