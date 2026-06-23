# 석암 전자서명 (seokam-sign)

교사가 PDF를 올리고 서명/입력 필드 영역을 지정 → 만료 링크로 학부모가 작성·손글씨 서명 → 교사가 완료 확인 및 합성 PDF 다운로드/인쇄하는 독립 앱.

- 스택: Node.js + Express + Supabase(공유 `fyxskyrzkjbfzlhfukbg`) + Railway + GitHub(vygotsky007/seokam-sign)
- 렌더: pdf.js / 서명: canvas / 합성(예정): pdf-lib
- 앱 자체 알림 없음 (사람이 문자/학교종이로 통보)

## 개발 단계
- **① (현재)**: PDF 업로드 + 필드 영역 지정(text/confirm/checkbox/signature, 빨강=필수) + 저장
- ②: 만료 링크(1·3·7일/1회용) + 안내문구 복사 + 학부모 작성/서명 화면
- ③: 서명 합성 PDF + 교직원 목록(완료표시·다운로드·인쇄)

## 필드 4종
| 타입 | 설명 | answer 컬럼 |
|------|------|------------|
| text | 텍스트 입력 | - |
| confirm | 확인문구 따라쓰기 | 정답 문구 |
| checkbox | 동의 체크 | 동의 문구 |
| signature | 손글씨 서명 전용 | - |

좌표는 페이지번호 + 상대좌표(0~1 비율)로 저장 → 해상도 독립.

## 로컬 실행
```bash
npm install
cp .env.example .env   # 키 채우기 (없으면 .localstore 로컬 폴백)
npm start              # http://localhost:3500
```

환경변수(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`)가 없으면 `.localstore`에 저장하는 폴백 모드로 동작(개발/검증용). 운영(Railway)에서는 반드시 설정.

## Storage
- 버킷 `sign-docs` (비공개). 서버가 서비스키로 업로드/다운로드(프록시). 버킷 없으면 자동 생성.
- 업로드 규칙: 최대 32MB, PDF만, 서비스키 사용(anon 금지).

## DB (Supabase SQL Editor에서 먼저 실행)
`schema.sql` 참고. RLS는 끄고 서버 서비스키로만 접근.
