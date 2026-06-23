-- ===========================================================================
-- 석암 전자서명 (seokam-sign) · ②단계 스키마 (만료 링크 + 응답)
-- 공유 Supabase 프로젝트: fyxskyrzkjbfzlhfukbg
-- ①단계 schema.sql 실행 후, 이 파일을 Supabase SQL Editor에서 실행하세요.
-- RLS는 끄고 서버 서비스키로만 접근합니다.
-- ===========================================================================

-- 만료 링크 (한 문서 → 여러 링크, 학부모마다 다른 토큰)
create table if not exists public.sign_links (
  id          uuid primary key,
  doc_id      uuid not null references public.documents(id) on delete cascade,
  token       text not null unique,          -- URL-safe 8자, /f/<token>
  seq         integer not null default 1,    -- 발급 순번 (#1, #2 …)
  expires_at  timestamptz not null,          -- 마감 일시
  one_time    boolean not null default true, -- 1회용(제출 시 자동 닫힘)
  is_closed   boolean not null default false,-- 수동/자동 닫힘
  created_at  timestamptz not null default now()
);

create index if not exists idx_sign_links_doc   on public.sign_links(doc_id);
create index if not exists idx_sign_links_token on public.sign_links(token);

-- 학부모 응답 (링크당 1건 upsert → 마감 전 재작성 시 덮어쓰기)
create table if not exists public.sign_responses (
  id             uuid primary key,
  link_id        uuid not null references public.sign_links(id) on delete cascade,
  token          text not null,
  values         jsonb not null default '{}'::jsonb,  -- {field_id: 입력값}
  signature_path text,                                -- Storage(sign-docs) 서명 PNG 경로
  submitted_at   timestamptz not null default now(),
  unique (link_id)                                    -- 링크당 1건
);

create index if not exists idx_sign_responses_link on public.sign_responses(link_id);

-- RLS 비활성 (서버 서비스키 전용)
alter table public.sign_links     disable row level security;
alter table public.sign_responses disable row level security;

-- PostgREST 스키마 캐시 리로드
notify pgrst, 'reload schema';
