'use strict';

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const archiver = require('archiver');
const { mergePdf, maskName } = require('./merge');

const FONT_PATH = path.join(__dirname, 'assets', 'NanumGothic-KR.ttf');
let FONT_BYTES = null;
try { FONT_BYTES = fs.readFileSync(FONT_PATH); }
catch (e) { console.warn('[seokam-sign] 경고: 한글 폰트(assets/NanumGothic-KR.ttf) 없음 — 합성 시 한글이 깨질 수 있습니다.'); }

const app = express();
const PORT = process.env.PORT || 3500;

// ---------------------------------------------------------------------------
// Supabase 셋업 (서비스키 = 쓰기/업로드, anon = 향후 사용)
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON_KEY = process.env.SUPABASE_KEY || '';
const BUCKET = 'sign-docs';

let supa = null; // 서비스 롤 클라이언트
const USE_SUPABASE = Boolean(SUPABASE_URL && SERVICE_KEY);

if (USE_SUPABASE) {
  supa = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  console.log('[seokam-sign] Supabase 서비스 클라이언트 활성화:', SUPABASE_URL);
  if (!ANON_KEY) console.warn('[seokam-sign] 경고: SUPABASE_KEY(anon) 미설정 (1단계는 무방).');
} else {
  console.warn('============================================================');
  console.warn('[seokam-sign] 경고: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 미설정.');
  console.warn('[seokam-sign] => 로컬 파일 저장소(.localstore)로 폴백합니다 (개발/검증용).');
  console.warn('[seokam-sign] => 운영(Railway)에서는 반드시 환경변수를 설정하세요.');
  console.warn('============================================================');
}

// ---------------------------------------------------------------------------
// 로컬 폴백 저장소 (Supabase 미설정 시)
// ---------------------------------------------------------------------------
const LOCAL_DIR = path.join(__dirname, '.localstore');
const LOCAL_PDF_DIR = path.join(LOCAL_DIR, 'pdfs');
const LOCAL_DB = path.join(LOCAL_DIR, 'db.json');

function ensureLocalStore() {
  if (!fs.existsSync(LOCAL_PDF_DIR)) fs.mkdirSync(LOCAL_PDF_DIR, { recursive: true });
  if (!fs.existsSync(LOCAL_DB)) fs.writeFileSync(LOCAL_DB, JSON.stringify({ documents: [], fields: [], links: [], responses: [] }, null, 2));
}
function readLocalDB() {
  ensureLocalStore();
  let db;
  try { db = JSON.parse(fs.readFileSync(LOCAL_DB, 'utf8')); }
  catch { db = {}; }
  db.documents = db.documents || [];
  db.fields = db.fields || [];
  db.links = db.links || [];
  db.responses = db.responses || [];
  return db;
}
function writeLocalDB(db) {
  ensureLocalStore();
  fs.writeFileSync(LOCAL_DB, JSON.stringify(db, null, 2));
}

// ---------------------------------------------------------------------------
// Storage 버킷 보장 (없으면 서비스키로 생성)
// ---------------------------------------------------------------------------
async function ensureBucket() {
  if (!USE_SUPABASE) return;
  try {
    const { data: buckets, error } = await supa.storage.listBuckets();
    if (error) throw error;
    const exists = (buckets || []).some((b) => b.name === BUCKET);
    if (!exists) {
      const { error: cErr } = await supa.storage.createBucket(BUCKET, {
        public: false,
        fileSizeLimit: '32MB',
        allowedMimeTypes: ['application/pdf'],
      });
      if (cErr) throw cErr;
      console.log(`[seokam-sign] Storage 버킷 '${BUCKET}' 생성 완료.`);
    } else {
      console.log(`[seokam-sign] Storage 버킷 '${BUCKET}' 확인됨.`);
    }
  } catch (e) {
    console.error('[seokam-sign] 버킷 보장 실패:', e.message || e);
  }
}

// ---------------------------------------------------------------------------
// 미들웨어
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '32mb' }));
app.use(express.urlencoded({ extended: true, limit: '32mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 }, // 32MB
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname || '');
    if (!ok) return cb(new Error('PDF 파일만 업로드할 수 있습니다.'));
    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
// API: 문서 업로드 (PDF + 제목)
// ---------------------------------------------------------------------------
app.post('/api/documents', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'PDF 파일이 없습니다.' });
    const title = (req.body.title || '').trim() || (req.file.originalname || '문서').replace(/\.pdf$/i, '');
    const createdBy = (req.body.created_by || '').trim() || null;
    const id = crypto.randomUUID();
    const storagePath = `${id}.pdf`;

    if (USE_SUPABASE) {
      const { error: upErr } = await supa.storage
        .from(BUCKET)
        .upload(storagePath, req.file.buffer, { contentType: 'application/pdf', upsert: true });
      if (upErr) throw upErr;

      const { error: dbErr } = await supa.from('documents').insert({
        id, title, pdf_path: storagePath, created_by: createdBy,
      });
      if (dbErr) throw dbErr;
    } else {
      ensureLocalStore();
      fs.writeFileSync(path.join(LOCAL_PDF_DIR, storagePath), req.file.buffer);
      const db = readLocalDB();
      db.documents.push({
        id, title, pdf_path: storagePath, created_by: createdBy,
        created_at: new Date().toISOString(),
      });
      writeLocalDB(db);
    }

    res.json({ id, title, pdf_path: storagePath });
  } catch (e) {
    console.error('업로드 오류:', e.message || e);
    res.status(500).json({ error: e.message || '업로드 실패' });
  }
});

// ---------------------------------------------------------------------------
// API: 문서 PDF 바이트 프록시 (버킷 비공개 유지, 서버가 서비스키로 스트림)
// ---------------------------------------------------------------------------
app.get('/api/documents/:id/pdf', async (req, res) => {
  try {
    const id = req.params.id;
    let storagePath = `${id}.pdf`;

    if (USE_SUPABASE) {
      const { data: doc } = await supa.from('documents').select('pdf_path').eq('id', id).single();
      if (doc && doc.pdf_path) storagePath = doc.pdf_path;
      const { data, error } = await supa.storage.from(BUCKET).download(storagePath);
      if (error) throw error;
      const buf = Buffer.from(await data.arrayBuffer());
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline');
      return res.send(buf);
    } else {
      const fp = path.join(LOCAL_PDF_DIR, storagePath);
      if (!fs.existsSync(fp)) return res.status(404).json({ error: '파일 없음' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline');
      return res.send(fs.readFileSync(fp));
    }
  } catch (e) {
    console.error('PDF 프록시 오류:', e.message || e);
    res.status(500).json({ error: e.message || 'PDF 로드 실패' });
  }
});

// ---------------------------------------------------------------------------
// API: 필드 저장 (해당 문서 필드 전체 교체)
// ---------------------------------------------------------------------------
app.post('/api/documents/:id/fields', async (req, res) => {
  try {
    const docId = req.params.id;
    const fields = Array.isArray(req.body.fields) ? req.body.fields : [];

    const clean = fields.map((f, i) => ({
      id: f.id || crypto.randomUUID(),
      doc_id: docId,
      page: Number.isFinite(f.page) ? f.page : 0,
      x: clamp01(f.x), y: clamp01(f.y), w: clamp01(f.w), h: clamp01(f.h),
      type: ['text', 'confirm', 'checkbox', 'signature'].includes(f.type) ? f.type : 'text',
      label: (f.label || '').toString().slice(0, 200),
      required: f.required === true,
      answer: (f.answer == null ? null : f.answer.toString().slice(0, 500)),
      sort: Number.isFinite(f.sort) ? f.sort : i,
    }));

    if (USE_SUPABASE) {
      const { error: delErr } = await supa.from('fields').delete().eq('doc_id', docId);
      if (delErr) throw delErr;
      if (clean.length) {
        const { error: insErr } = await supa.from('fields').insert(clean);
        if (insErr) throw insErr;
      }
    } else {
      const db = readLocalDB();
      db.fields = db.fields.filter((f) => f.doc_id !== docId).concat(clean);
      writeLocalDB(db);
    }

    res.json({ ok: true, count: clean.length });
  } catch (e) {
    console.error('필드 저장 오류:', e.message || e);
    res.status(500).json({ error: e.message || '필드 저장 실패' });
  }
});

// ---------------------------------------------------------------------------
// API: 문서 + 필드 조회 (새로고침 복원용)
// ---------------------------------------------------------------------------
app.get('/api/documents/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (USE_SUPABASE) {
      const { data: doc, error: dErr } = await supa.from('documents').select('*').eq('id', id).single();
      if (dErr) throw dErr;
      const { data: fields, error: fErr } = await supa.from('fields').select('*').eq('doc_id', id).order('sort');
      if (fErr) throw fErr;
      res.json({ document: doc, fields: fields || [] });
    } else {
      const db = readLocalDB();
      const doc = db.documents.find((d) => d.id === id);
      if (!doc) return res.status(404).json({ error: '문서 없음' });
      const fields = db.fields.filter((f) => f.doc_id === id).sort((a, b) => a.sort - b.sort);
      res.json({ document: doc, fields });
    }
  } catch (e) {
    console.error('문서 조회 오류:', e.message || e);
    res.status(500).json({ error: e.message || '조회 실패' });
  }
});

// ---------------------------------------------------------------------------
// API: 문서 목록 (교사가 다시 열기)
// ---------------------------------------------------------------------------
app.get('/api/documents', async (req, res) => {
  try {
    if (USE_SUPABASE) {
      const { data, error } = await supa.from('documents').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      res.json({ documents: data || [] });
    } else {
      const db = readLocalDB();
      const docs = [...db.documents].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      res.json({ documents: docs });
    }
  } catch (e) {
    res.status(500).json({ error: e.message || '목록 조회 실패' });
  }
});

// ---------------------------------------------------------------------------
// ②단계: 필드 필수여부만 갱신 (링크 만들기 화면에서)
// ---------------------------------------------------------------------------
app.post('/api/documents/:id/fields/required', async (req, res) => {
  try {
    const docId = req.params.id;
    const updates = Array.isArray(req.body.updates) ? req.body.updates : [];
    if (USE_SUPABASE) {
      for (const u of updates) {
        if (!u || !u.id) continue;
        const { error } = await supa.from('fields')
          .update({ required: u.required === true }).eq('id', u.id).eq('doc_id', docId);
        if (error) throw error;
      }
    } else {
      const db = readLocalDB();
      const map = new Map(updates.map((u) => [u.id, u.required === true]));
      db.fields.forEach((f) => { if (f.doc_id === docId && map.has(f.id)) f.required = map.get(f.id); });
      writeLocalDB(db);
    }
    res.json({ ok: true, count: updates.length });
  } catch (e) {
    console.error('필수설정 오류:', e.message || e);
    res.status(500).json({ error: e.message || '필수 설정 실패' });
  }
});

// ---------------------------------------------------------------------------
// ②단계: 링크 N개 생성
// ---------------------------------------------------------------------------
function makeToken() {
  // URL-safe 8자
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += alpha[bytes[i] % alpha.length];
  return s;
}

app.post('/api/documents/:id/links', async (req, res) => {
  try {
    const docId = req.params.id;
    let count = parseInt(req.body.count, 10);
    let days = parseInt(req.body.expires_days, 10);
    const oneTime = req.body.one_time === true;
    if (!Number.isFinite(count) || count < 1) count = 1;
    if (count > 200) count = 200; // 안전 상한
    if (!Number.isFinite(days) || days < 1) days = 7;
    if (days > 365) days = 365;
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();

    // 기존 링크 수 → seq 이어붙이기
    let baseSeq = 0;
    if (USE_SUPABASE) {
      const { count: existing } = await supa.from('sign_links')
        .select('id', { count: 'exact', head: true }).eq('doc_id', docId);
      baseSeq = existing || 0;
    } else {
      const db = readLocalDB();
      baseSeq = db.links.filter((l) => l.doc_id === docId).length;
    }

    const rows = [];
    for (let i = 0; i < count; i++) {
      rows.push({
        id: crypto.randomUUID(), doc_id: docId, token: makeToken(),
        seq: baseSeq + i + 1, expires_at: expiresAt, one_time: oneTime,
        is_closed: false, created_at: new Date().toISOString(),
      });
    }

    if (USE_SUPABASE) {
      const { error } = await supa.from('sign_links').insert(rows);
      if (error) throw error;
    } else {
      const db = readLocalDB();
      db.links.push(...rows);
      writeLocalDB(db);
    }
    res.json({ ok: true, count: rows.length, expires_at: expiresAt, links: rows });
  } catch (e) {
    console.error('링크 생성 오류:', e.message || e);
    res.status(500).json({ error: e.message || '링크 생성 실패' });
  }
});

// ②단계: 링크 목록 (상태 포함)
app.get('/api/documents/:id/links', async (req, res) => {
  try {
    const docId = req.params.id;
    let links = [], responded = new Set();
    if (USE_SUPABASE) {
      const { data, error } = await supa.from('sign_links').select('*').eq('doc_id', docId).order('seq');
      if (error) throw error;
      links = data || [];
      const ids = links.map((l) => l.id);
      if (ids.length) {
        const { data: rs } = await supa.from('sign_responses').select('link_id').in('link_id', ids);
        (rs || []).forEach((r) => responded.add(r.link_id));
      }
    } else {
      const db = readLocalDB();
      links = db.links.filter((l) => l.doc_id === docId).sort((a, b) => a.seq - b.seq);
      db.responses.forEach((r) => responded.add(r.link_id));
    }
    const now = Date.now();
    const out = links.map((l) => ({
      ...l,
      done: responded.has(l.id),
      expired: new Date(l.expires_at).getTime() < now,
      status: l.is_closed ? 'closed'
        : (new Date(l.expires_at).getTime() < now ? 'expired'
        : (responded.has(l.id) ? 'done' : 'open')),
    }));
    res.json({ links: out });
  } catch (e) {
    console.error('링크 목록 오류:', e.message || e);
    res.status(500).json({ error: e.message || '링크 목록 실패' });
  }
});

// ②단계: 링크 열기/닫기
app.post('/api/links/:linkId/toggle', async (req, res) => {
  try {
    const linkId = req.params.linkId;
    const isClosed = req.body.is_closed === true;
    if (USE_SUPABASE) {
      const { error } = await supa.from('sign_links').update({ is_closed: isClosed }).eq('id', linkId);
      if (error) throw error;
    } else {
      const db = readLocalDB();
      const l = db.links.find((x) => x.id === linkId);
      if (!l) return res.status(404).json({ error: '링크 없음' });
      l.is_closed = isClosed;
      writeLocalDB(db);
    }
    res.json({ ok: true, is_closed: isClosed });
  } catch (e) {
    res.status(500).json({ error: e.message || '토글 실패' });
  }
});

// ---------------------------------------------------------------------------
// ②-2단계: 학부모 작성/서명
// ---------------------------------------------------------------------------
const SIG_DIR = path.join(LOCAL_DIR, 'sigs');

function normalizeConfirm(s) {
  // 공백·문장부호·기호 제거 + 소문자 → 글자만 비교
  return (s || '').toString().replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

async function getLinkBundle(token) {
  let link = null, doc = null, fields = [], response = null;
  if (USE_SUPABASE) {
    const { data: l } = await supa.from('sign_links').select('*').eq('token', token).single();
    if (!l) return null;
    link = l;
    const { data: d } = await supa.from('documents').select('*').eq('id', l.doc_id).single();
    doc = d || null;
    const { data: fs2 } = await supa.from('fields').select('*').eq('doc_id', l.doc_id).order('sort');
    fields = fs2 || [];
    const { data: r } = await supa.from('sign_responses').select('*').eq('link_id', l.id).single();
    response = r || null;
  } else {
    const db = readLocalDB();
    link = db.links.find((x) => x.token === token) || null;
    if (!link) return null;
    doc = db.documents.find((x) => x.id === link.doc_id) || null;
    fields = db.fields.filter((f) => f.doc_id === link.doc_id).sort((a, b) => a.sort - b.sort);
    response = db.responses.find((r) => r.link_id === link.id) || null;
  }
  return { link, doc, fields, response };
}

function linkState(link) {
  if (link.is_closed) return 'closed';
  if (new Date(link.expires_at).getTime() < Date.now()) return 'expired';
  return 'open';
}

// 토큰으로 작성 화면 데이터 조회 (읽기: 친절한 사유 반환)
app.get('/api/f/:token', async (req, res) => {
  try {
    const bundle = await getLinkBundle(req.params.token);
    if (!bundle || !bundle.doc) return res.json({ ok: false, reason: 'notfound' });
    const st = linkState(bundle.link);
    if (st !== 'open') return res.json({ ok: false, reason: st, title: bundle.doc.title });
    res.json({
      ok: true,
      title: bundle.doc.title,
      expires_at: bundle.link.expires_at,
      fields: bundle.fields,
      values: bundle.response ? bundle.response.values : {},
      has_response: !!bundle.response,
    });
  } catch (e) {
    console.error('작성조회 오류:', e.message || e);
    res.status(500).json({ ok: false, reason: 'error' });
  }
});

// PDF 프록시 (토큰 기반)
app.get('/api/f/:token/pdf', async (req, res) => {
  try {
    const bundle = await getLinkBundle(req.params.token);
    if (!bundle || !bundle.doc) return res.status(404).end();
    const sp = bundle.doc.pdf_path || `${bundle.doc.id}.pdf`;
    if (USE_SUPABASE) {
      const { data, error } = await supa.storage.from(BUCKET).download(sp);
      if (error) throw error;
      const buf = Buffer.from(await data.arrayBuffer());
      res.setHeader('Content-Type', 'application/pdf'); return res.send(buf);
    } else {
      const fp = path.join(LOCAL_PDF_DIR, sp);
      if (!fs.existsSync(fp)) return res.status(404).end();
      res.setHeader('Content-Type', 'application/pdf'); return res.send(fs.readFileSync(fp));
    }
  } catch (e) { res.status(500).end(); }
});

// 기존 서명 이미지 프록시 (재작성 시 미리보기)
app.get('/api/f/:token/sig/:fieldId', async (req, res) => {
  try {
    const bundle = await getLinkBundle(req.params.token);
    if (!bundle || !bundle.response) return res.status(404).end();
    const sp = (bundle.response.values || {})[req.params.fieldId];
    if (!sp || typeof sp !== 'string' || !sp.startsWith('responses/')) return res.status(404).end();
    if (USE_SUPABASE) {
      const { data, error } = await supa.storage.from(BUCKET).download(sp);
      if (error) throw error;
      const buf = Buffer.from(await data.arrayBuffer());
      res.setHeader('Content-Type', 'image/png'); return res.send(buf);
    } else {
      const fp = path.join(SIG_DIR, path.basename(sp));
      if (!fs.existsSync(fp)) return res.status(404).end();
      res.setHeader('Content-Type', 'image/png'); return res.send(fs.readFileSync(fp));
    }
  } catch (e) { res.status(404).end(); }
});

// 제출 (쓰기: 만료/닫힘 403, 필수 검증 400, 링크당 1건 upsert)
app.post('/api/f/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const bundle = await getLinkBundle(token);
    if (!bundle || !bundle.doc) return res.status(404).json({ error: '링크를 찾을 수 없습니다.' });
    const st = linkState(bundle.link);
    if (st !== 'open') return res.status(403).json({ error: st === 'closed' ? '닫힌 링크입니다.' : '마감된 링크입니다.', reason: st });

    const inVals = (req.body && typeof req.body.values === 'object' && req.body.values) || {};
    const inSigs = (req.body && typeof req.body.signatures === 'object' && req.body.signatures) || {};
    const fields = bundle.fields;

    // 서버측 필수 검증
    const missing = [];
    for (const f of fields) {
      if (!f.required) continue;
      if (f.type === 'text') { if (!(inVals[f.id] || '').toString().trim()) missing.push(f.label); }
      else if (f.type === 'confirm') {
        const v = (inVals[f.id] || '').toString();
        if (!v.trim() || normalizeConfirm(v) !== normalizeConfirm(f.answer)) missing.push(f.label + '(따라쓰기 불일치)');
      } else if (f.type === 'checkbox') { if (inVals[f.id] !== true) missing.push(f.label); }
      else if (f.type === 'signature') { if (!inSigs[f.id]) missing.push(f.label); }
    }
    if (missing.length) return res.status(400).json({ error: '필수 항목을 확인하세요: ' + missing.join(', '), missing });

    // 서명 이미지 저장 (dataURL → PNG)
    const values = {};
    for (const f of fields) {
      if (f.type === 'signature') continue;
      if (f.type === 'checkbox') values[f.id] = inVals[f.id] === true;
      else if (inVals[f.id] != null) values[f.id] = inVals[f.id].toString().slice(0, 1000);
    }
    let primarySig = null;
    for (const f of fields) {
      if (f.type !== 'signature') continue;
      const dataUrl = inSigs[f.id];
      if (!dataUrl) continue;
      const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      const spath = `responses/${bundle.link.id}__${f.id}.png`;
      if (USE_SUPABASE) {
        const { error } = await supa.storage.from(BUCKET).upload(spath, buf, { contentType: 'image/png', upsert: true });
        if (error) throw error;
      } else {
        if (!fs.existsSync(SIG_DIR)) fs.mkdirSync(SIG_DIR, { recursive: true });
        fs.writeFileSync(path.join(SIG_DIR, path.basename(spath)), buf);
      }
      values[f.id] = spath;
      if (!primarySig) primarySig = spath;
    }

    const row = {
      id: bundle.response ? bundle.response.id : crypto.randomUUID(),
      link_id: bundle.link.id, token, values,
      signature_path: primarySig, submitted_at: new Date().toISOString(),
    };

    // 링크당 1건: 삭제 후 삽입 (재작성=덮어쓰기)
    if (USE_SUPABASE) {
      await supa.from('sign_responses').delete().eq('link_id', bundle.link.id);
      const { error } = await supa.from('sign_responses').insert(row);
      if (error) throw error;
      if (bundle.link.one_time) await supa.from('sign_links').update({ is_closed: true }).eq('id', bundle.link.id);
    } else {
      const db = readLocalDB();
      db.responses = db.responses.filter((r) => r.link_id !== bundle.link.id);
      db.responses.push(row);
      if (bundle.link.one_time) { const l = db.links.find((x) => x.id === bundle.link.id); if (l) l.is_closed = true; }
      writeLocalDB(db);
    }
    res.json({ ok: true, closed: bundle.link.one_time === true });
  } catch (e) {
    console.error('제출 오류:', e.message || e);
    res.status(500).json({ error: e.message || '제출 실패' });
  }
});

// 학부모 작성 화면 (HTML)
app.get('/f/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'form.html'));
});



// ---------------------------------------------------------------------------
// ③단계: 합성 PDF + 교직원 목록 + ZIP 일괄
// ---------------------------------------------------------------------------
async function getPdfBytes(doc) {
  const sp = doc.pdf_path || `${doc.id}.pdf`;
  if (USE_SUPABASE) {
    const { data, error } = await supa.storage.from(BUCKET).download(sp);
    if (error) throw error;
    return Buffer.from(await data.arrayBuffer());
  }
  return fs.readFileSync(path.join(LOCAL_PDF_DIR, sp));
}
async function getSigBytes(spath) {
  if (!spath || typeof spath !== 'string' || !spath.startsWith('responses/')) return null;
  try {
    if (USE_SUPABASE) {
      const { data, error } = await supa.storage.from(BUCKET).download(spath);
      if (error) throw error;
      return Buffer.from(await data.arrayBuffer());
    }
    const fp = path.join(SIG_DIR, path.basename(spath));
    return fs.existsSync(fp) ? fs.readFileSync(fp) : null;
  } catch (e) { return null; }
}

// 문서 전체 데이터 (doc, fields, links, responses) 한 번에
async function getDocFull(docId) {
  let doc, fields, links, responses;
  if (USE_SUPABASE) {
    const { data: d } = await supa.from('documents').select('*').eq('id', docId).single();
    doc = d;
    const { data: f } = await supa.from('fields').select('*').eq('doc_id', docId).order('sort');
    fields = f || [];
    const { data: l } = await supa.from('sign_links').select('*').eq('doc_id', docId).order('seq');
    links = l || [];
    const ids = links.map((x) => x.id);
    if (ids.length) { const { data: r } = await supa.from('sign_responses').select('*').in('link_id', ids); responses = r || []; }
    else responses = [];
  } else {
    const db = readLocalDB();
    doc = db.documents.find((x) => x.id === docId);
    fields = db.fields.filter((x) => x.doc_id === docId).sort((a, b) => a.sort - b.sort);
    links = db.links.filter((x) => x.doc_id === docId).sort((a, b) => a.seq - b.seq);
    responses = db.responses.filter((r) => links.some((l) => l.id === r.link_id));
  }
  return { doc, fields, links, responses };
}

function nameFieldId(fields) {
  const t = fields.find((f) => f.type === 'text');
  return t ? t.id : null;
}

// 교직원: 제출 현황 목록
app.get('/api/documents/:id/submissions', async (req, res) => {
  try {
    const { doc, fields, links, responses } = await getDocFull(req.params.id);
    if (!doc) return res.status(404).json({ error: '문서 없음' });
    const nfid = nameFieldId(fields);
    const rmap = new Map(responses.map((r) => [r.link_id, r]));
    const now = Date.now();
    const rows = links.map((l) => {
      const r = rmap.get(l.id);
      const status = l.is_closed ? 'closed'
        : (new Date(l.expires_at).getTime() < now ? 'expired' : (r ? 'done' : 'open'));
      return {
        link_id: l.id, seq: l.seq, token: l.token,
        done: !!r,
        name: r && nfid ? maskName((r.values || {})[nfid]) : null,
        submitted_at: r ? r.submitted_at : null,
        status,
      };
    });
    res.json({
      title: doc.title,
      total: links.length,
      done: rows.filter((x) => x.done).length,
      rows,
    });
  } catch (e) {
    console.error('제출현황 오류:', e.message || e);
    res.status(500).json({ error: e.message || '제출현황 실패' });
  }
});

app.get('/api/links/:linkId/merged.pdf', async (req, res) => {
  try {
    const linkId = req.params.linkId;
    // 링크 → 문서 → 데이터
    let link;
    if (USE_SUPABASE) { const { data } = await supa.from('sign_links').select('*').eq('id', linkId).single(); link = data; }
    else { link = readLocalDB().links.find((x) => x.id === linkId); }
    if (!link) return res.status(404).json({ error: '링크 없음' });
    const { doc, fields, responses } = await getDocFull(link.doc_id);
    const resp = responses.find((r) => r.link_id === linkId);
    if (!resp) return res.status(404).json({ error: '아직 작성되지 않았습니다.' });

    const pdfBytes = await getPdfBytes(doc);
    const sigBuffers = {};
    for (const f of fields) {
      if (f.type === 'signature') {
        const b = await getSigBytes((resp.values || {})[f.id]);
        if (b) sigBuffers[f.id] = b;
      }
    }
    const out = await mergePdf({ pdfBytes, fontBytes: FONT_BYTES, fields, values: resp.values || {}, sigBuffers });
    const nfid = nameFieldId(fields);
    const nm = nfid ? maskName((resp.values || {})[nfid]) : '';
    const fname = encodeURIComponent(`${doc.title}_${nm || ('link' + link.seq)}.pdf`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.dl ? 'attachment' : 'inline'}; filename*=UTF-8''${fname}`);
    res.send(Buffer.from(out));
  } catch (e) {
    console.error('합성 오류:', e.message || e);
    res.status(500).json({ error: e.message || '합성 실패' });
  }
});

// 작성분 일괄 ZIP
app.get('/api/documents/:id/merged.zip', async (req, res) => {
  try {
    const { doc, fields, links, responses } = await getDocFull(req.params.id);
    if (!doc) return res.status(404).json({ error: '문서 없음' });
    const rmap = new Map(responses.map((r) => [r.link_id, r]));
    const done = links.filter((l) => rmap.has(l.id));
    if (!done.length) return res.status(404).json({ error: '작성된 문서가 없습니다.' });

    const pdfBytes = await getPdfBytes(doc);
    const nfid = nameFieldId(fields);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.title + '_작성분.zip')}`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => { console.error('zip err', err); try { res.status(500).end(); } catch (e) {} });
    archive.pipe(res);

    for (const l of done) {
      const resp = rmap.get(l.id);
      const sigBuffers = {};
      for (const f of fields) {
        if (f.type === 'signature') { const b = await getSigBytes((resp.values || {})[f.id]); if (b) sigBuffers[f.id] = b; }
      }
      const out = await mergePdf({ pdfBytes, fontBytes: FONT_BYTES, fields, values: resp.values || {}, sigBuffers });
      const nm = nfid ? maskName((resp.values || {})[nfid]) : '';
      const seq = String(l.seq).padStart(2, '0');
      archive.append(Buffer.from(out), { name: `${seq}_${nm || ('link' + l.seq)}.pdf` });
    }
    await archive.finalize();
  } catch (e) {
    console.error('ZIP 오류:', e.message || e);
    try { res.status(500).json({ error: e.message || 'ZIP 실패' }); } catch (_) {}
  }
});



function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// multer 오류 핸들러
app.use((err, req, res, next) => {
  if (err) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '파일이 너무 큽니다 (최대 32MB).' : (err.message || '오류');
    return res.status(400).json({ error: msg });
  }
  next();
});

// ---------------------------------------------------------------------------
// 부팅
// ---------------------------------------------------------------------------
(async () => {
  await ensureBucket();
  app.listen(PORT, () => {
    console.log(`[seokam-sign] 서버 실행: http://localhost:${PORT}  (저장소: ${USE_SUPABASE ? 'Supabase' : '로컬폴백'})`);
  });
})();
