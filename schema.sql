-- ===========================================================================
-- 석암 전자서명 (seokam-sign) · ①단계 스키마
-- 공유 Supabase 프로젝트: fyxskyrzkjbfzlhfukbg
-- Supabase SQL Editor에서 먼저 실행하세요. (이 앱은 sign_ 접두사 사용)
-- RLS는 끄고 서버 서비스키로만 접근합니다.
-- ===========================================================================

-- 문서 (업로드된 PDF 템플릿)
create table if not exists public.documents (
  id          uuid primary key,
  title       text not null default '문서',
  pdf_path    text not null,                 -- Storage(sign-docs) 내 경로 (예: <id>.pdf)
  created_by  text,                          -- 작성 교사명(선택)
  created_at  timestamptz not null default now()
);

-- 필드 (문서 위에 지정한 입력/서명 영역)
create table if not exists public.fields (
  id        uuid primary key,
  doc_id    uuid not null references public.documents(id) on delete cascade,
  page      integer not null default 0,      -- 0-기준 페이지 인덱스
  x         double precision not null default 0,  -- 상대좌표(0~1)
  y         double precision not null default 0,
  w         double precision not null default 0,
  h         double precision not null default 0,
  type      text not null default 'text'     -- text | confirm | checkbox | signature
            check (type in ('text','confirm','checkbox','signature')),
  label     text not null default '',
  required  boolean not null default true,   -- 빨강=필수
  answer    text,                            -- confirm: 정답 문구 / checkbox: 동의 문구
  sort      integer not null default 0
);

create index if not exists idx_fields_doc on public.fields(doc_id);

-- RLS 비활성 (서버 서비스키 전용 접근)
alter table public.documents disable row level security;
alter table public.fields    disable row level security;

-- PostgREST 스키마 캐시 리로드
notify pgrst, 'reload schema';
