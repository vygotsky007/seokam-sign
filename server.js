'use strict';

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

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
  if (!fs.existsSync(LOCAL_DB)) fs.writeFileSync(LOCAL_DB, JSON.stringify({ documents: [], fields: [] }, null, 2));
}
function readLocalDB() {
  ensureLocalStore();
  try { return JSON.parse(fs.readFileSync(LOCAL_DB, 'utf8')); }
  catch { return { documents: [], fields: [] }; }
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

// 환경 정보 (클라이언트가 폴백 여부 표시)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, store: USE_SUPABASE ? 'supabase' : 'local', bucket: BUCKET });
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
