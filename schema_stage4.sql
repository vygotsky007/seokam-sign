-- ===========================================================================
-- 석암 전자서명 (seokam-sign) · 1순위 개선 (날짜·예/아니요 라디오·남길말·증빙)
-- 공유 Supabase 프로젝트: fyxskyrzkjbfzlhfukbg
-- 앞선 schema.sql / schema_stage2.sql 실행 후, 이 파일을 SQL Editor에서 실행하세요.
-- ===========================================================================

-- 1) fields 타입에 date / radio 추가 (CHECK 제약 교체)
alter table public.fields drop constraint if exists fields_type_check;
alter table public.fields add constraint fields_type_check
  check (type in ('text','confirm','checkbox','signature','date','radio'));

-- 2) 라디오 그룹 키 (같은 grp끼리 택1)
alter table public.fields add column if not exists grp text;

-- 3) 문서 남길 말(학부모 안내 메모)
alter table public.documents add column if not exists memo text;

-- 4) 제출 증빙용 IP
alter table public.sign_responses add column if not exists submit_ip text;

-- PostgREST 스키마 캐시 리로드
notify pgrst, 'reload schema';
