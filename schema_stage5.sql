-- ===========================================================================
-- 석암 전자서명 (seokam-sign) · ⑤단계 — 제출 시점 필드 스냅샷 (발급 후 수정 보존)
-- 앞선 schema.sql / stage2 / stage4 실행 후, 이 파일을 Supabase SQL Editor에서 실행하세요.
-- 목적: 학부모가 제출한 뒤 교사가 문서 필드를 수정해도, 이미 제출된 건의
--       합성 PDF는 "제출 당시 필드 배치/라벨/정답"으로 그대로 렌더되도록 스냅샷 보관.
-- ===========================================================================

-- 제출 당시의 필드 배열 스냅샷(좌표/타입/라벨/정답 포함). null 이면 라이브 필드 사용(구 데이터 호환).
alter table public.sign_responses
  add column if not exists fields_snapshot jsonb;

-- 제출 당시 문서 제목 스냅샷(파일명 표기용, 선택).
alter table public.sign_responses
  add column if not exists doc_title text;

-- PostgREST 스키마 캐시 리로드
notify pgrst, 'reload schema';
