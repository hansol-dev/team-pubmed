# Vercel 전환 계획

## 목표

현재 Render에서 실행 중인 FastAPI 애플리케이션을 Vercel의 Python Runtime으로 이전합니다. 프론트엔드와 API를 분리해 재작성하지 않고, 기존 Jinja2 화면·Google OAuth·Supabase·SSE 챗봇을 유지하는 **최소 변경 이전**을 우선합니다.

## 현재 구조와 호환성

| 항목 | 현재 구현 | Vercel 판단 | 대응 |
| --- | --- | --- | --- |
| FastAPI | 단일 `main.py` ASGI 앱 | 지원 | Vercel이 인식하는 `app.py` 진입점 추가 |
| Jinja2·정적 파일 | 저장소 내부 디렉터리 | 지원 | 번들에 `templates/`, `static/` 포함 여부 검증 |
| PostgreSQL | 요청마다 psycopg 연결 | 지원 | Supabase Transaction Pooler로 변경 |
| SQLite | 로컬 파일 쓰기 | 운영용으로 부적합 | Vercel에서는 `DATABASE_URL`을 필수로 검증 |
| Google OAuth | 서명 쿠키 세션 | 지원 | Preview·Production 콜백 URI 등록 |
| 챗봇 SSE | `StreamingResponse` | Python Runtime 지원 | 실제 브라우저 스트리밍과 제한 시간 검증 |
| PubMed 수집 | 요청 안에서 외부 API 호출 | 조건부 지원 | 함수 제한 시간, NCBI 속도 제한과 실패 응답 검증 |

Vercel Functions의 파일 시스템은 읽기 전용이며 `/tmp`만 임시 쓰기가 가능합니다. 따라서 배포 환경에서 SQLite를 영구 저장소로 사용하지 않고 Supabase 연결 실패 시 즉시 실패하도록 해야 합니다.

## 1단계 — 기준선 고정

- 현재 Render 운영 버전의 `/health`, 로그인, 논문 수집, 통계, 검색, CSV, 챗봇 결과를 기록합니다.
- 전체 테스트를 통과시켜 이전 전 기준선을 만듭니다.
- Supabase 백업 또는 복구 지점을 확인합니다.
- Render는 전환이 끝날 때까지 유지해 즉시 롤백할 수 있게 합니다.

**완료 조건:** 현재 운영 기능과 테스트 결과가 체크리스트로 남아 있어야 합니다.

## 2단계 — Vercel 실행 설정

예상 변경 파일:

- `app.py`: `main.app`을 다시 내보내는 Vercel용 ASGI 진입점
- `.python-version`: Python 3.12 고정
- `vercel.json`: Python 함수의 최대 실행 시간과 필요 시 실행 리전 설정
- `.vercelignore`: 테스트·로컬 DB·개발 산출물을 함수 번들에서 제외

설정 후 Vercel CLI 로컬 실행과 Preview Deployment에서 다음을 확인합니다.

- `/`, `/static/*`, 템플릿 렌더링
- `/health`와 `/docs`
- 정적 파일 경로가 배포 번들에서도 저장소 루트를 기준으로 해석되는지
- 함수 번들이 Vercel 제한 안에 들어가는지

**완료 조건:** 로그인하지 않은 랜딩 페이지와 API 문서가 Preview URL에서 정상 표시되어야 합니다.

## 3단계 — Supabase를 서버리스 연결로 변경

Vercel 같은 임시 서버리스 함수에는 Supabase **Transaction Pooler(포트 6543)**를 사용합니다.

- Vercel `DATABASE_URL`을 Transaction Pooler 연결 문자열로 설정합니다.
- 현재 psycopg 설정의 `prepare_threshold=None`을 유지합니다. Transaction Pooler는 prepared statement를 지원하지 않습니다.
- 배포 환경에서 `DATABASE_URL`이 없을 때 SQLite로 조용히 전환되지 않도록 시작 또는 첫 DB 요청에서 명확한 오류를 내게 합니다.
- 동시 요청으로 로그인, 논문 목록, 통계, 채팅 기록을 반복 호출해 연결 고갈 여부를 확인합니다.

**완료 조건:** Preview 환경에서 모든 쓰기 데이터가 Supabase에 남고, 함수 재시작 후에도 유지되어야 합니다.

## 4단계 — 인증과 비밀값 설정

Vercel의 Preview와 Production 환경을 분리해 다음 환경 변수를 설정합니다.

```text
DATABASE_URL
SESSION_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
OPENAI_API_KEY
NCBI_API_KEY
NCBI_EMAIL
HTTPS_ONLY=true
```

- Production의 `SESSION_SECRET`은 기존 값을 유지하면 사용자 세션 전환 충격을 줄일 수 있습니다.
- Google OAuth 승인된 리디렉션 URI에 아래 주소를 추가합니다.

```text
https://<production-domain>/auth/callback
https://<preview-domain>/auth/callback
```

- Preview URL이 배포마다 바뀌므로 인증 전용 고정 도메인을 쓰거나, Preview에서는 OAuth 검증을 제한하고 Production 후보 도메인에서 전체 흐름을 검증합니다.
- 비밀값은 `vercel.json`이나 Git에 넣지 않습니다.

**완료 조건:** 로그인, 콜백, 로그아웃 후 세션 쿠키가 HTTPS에서 정상 작동해야 합니다.

## 5단계 — 장시간 요청과 스트리밍 검증

- `/api/chat/stream`이 토큰을 한 번에 모아서 보내지 않고 브라우저에 점진적으로 전달하는지 확인합니다.
- 정상 답변, 도구 검색이 포함된 답변, OpenAI 오류, 사용자가 연결을 끊은 경우를 시험합니다.
- `/api/collect`와 `/api/trend`를 최대 허용 범위로 호출해 실행 시간을 측정합니다.
- 측정값을 근거로 `maxDuration`을 설정하고, 타임아웃 직전 요청에는 사용자에게 재시도 가능한 오류를 반환합니다.
- `PUBMED_CONCURRENCY`는 프로세스 인스턴스 내부에서만 제한한다는 점을 고려해 NCBI API 키와 요청 속도 제한을 함께 검증합니다.

**완료 조건:** 챗봇 스트리밍과 최대 범위 PubMed 작업이 설정한 함수 제한 시간 안에서 끝나야 합니다.

## 6단계 — Production 전환

1. Vercel Production 후보 URL에서 전체 회귀 테스트를 수행합니다.
2. 커스텀 도메인을 Vercel 프로젝트에 연결합니다.
3. Google OAuth 콜백 URI를 최종 도메인 기준으로 확인합니다.
4. DNS를 전환하되 Render 서비스를 유지합니다.
5. 오류율, 함수 실행 시간, Supabase 연결 수와 OpenAI 실패를 집중 관찰합니다.
6. 안정화 후 README의 Live Demo·배포 구성·OAuth 예시를 Vercel 기준으로 갱신하고 `render.yaml` 제거 여부를 결정합니다.

## 롤백 기준

다음 중 하나가 발생하면 DNS 또는 운영 링크를 Render로 되돌립니다.

- 로그인 또는 OAuth 콜백이 반복적으로 실패
- Supabase 연결 고갈이나 데이터 쓰기 실패
- 챗봇 스트리밍이 중단되거나 응답이 함수 제한 시간을 반복 초과
- PubMed 최대 범위 수집이 안정적으로 완료되지 않음

Render 설정과 `render.yaml`은 Vercel 운영이 안정화될 때까지 삭제하지 않습니다. 데이터베이스는 두 배포가 동일한 Supabase를 사용하므로 스키마 변경은 이전 기간에 피하거나 양쪽 버전과 호환되게 적용합니다.

## 최종 검증 체크리스트

- [ ] 랜딩 페이지와 정적 파일
- [ ] Google 로그인·콜백·로그아웃
- [ ] 사용자별 논문 격리
- [ ] 논문 수집·중복 방지·PMID 검색
- [ ] 연구 추세와 저널 통계
- [ ] CSV 다운로드
- [ ] 챗봇 도구 검색·SSE 스트리밍·대화 저장
- [ ] 의료 조언 차단
- [ ] 함수 콜드 스타트와 최대 실행 시간
- [ ] Supabase 연결 수와 영속성
- [ ] Production 도메인과 HTTPS 쿠키
- [ ] Render 롤백 경로

## 참고 문서

- [FastAPI on Vercel](https://vercel.com/docs/frameworks/backend/fastapi)
- [Vercel Python Runtime](https://vercel.com/docs/functions/runtimes/python)
- [Vercel Functions streaming](https://vercel.com/docs/functions/streaming-functions)
- [Vercel Functions duration](https://vercel.com/docs/functions/configuring-functions/duration)
- [Supabase database connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase prepared statements](https://supabase.com/docs/guides/troubleshooting/disabling-prepared-statements-qL8lEL)
