# Publium Vercel 배포 가이드

Publium은 프론트엔드와 Express API를 하나의 Vercel 프로젝트에 배포하고,
인증과 PostgreSQL/pgvector 데이터베이스는 Supabase를 사용한다.

| 계층 | 배포 대상 | 공개 여부 |
| --- | --- | --- |
| React/Vite 프론트엔드 | Vercel Static Build | 공개 |
| Express API | Vercel Node Function | 서버 전용 비밀값 사용 |
| Auth/PostgreSQL/pgvector | Supabase | anon key만 브라우저 공개 |

```text
Browser
  ├─ /               -> Vite 정적 앱
  └─ /api/...        -> Express Vercel Function
                           ├─ Supabase Auth
                           ├─ Supabase PostgreSQL/pgvector
                           ├─ NCBI PubMed/PMC
                           └─ OpenAI
```

## 1. Supabase 준비

1. Supabase SQL Editor에서 [`supabase/schema.sql`](../supabase/schema.sql)을
   실행한다.
2. `vector`, `pgcrypto` extension과 애플리케이션 테이블이 생성됐는지
   확인한다.
3. Google provider를 활성화하고 Google OAuth client ID와 secret을
   등록한다.
4. 첫 Vercel 배포 후 Supabase **Authentication > URL Configuration**에서
   다음 값을 설정한다.

```text
Site URL: https://<VERCEL_PRODUCTION_DOMAIN>
Redirect URLs:
http://localhost:5173/**
https://<VERCEL_PRODUCTION_DOMAIN>/**
```

Google Cloud OAuth client의 Authorized redirect URI에는 Supabase callback을
등록한다.

```text
https://<SUPABASE_PROJECT_REF>.supabase.co/auth/v1/callback
```

## 2. Vercel 프로젝트 설정

같은 Git 저장소를 새 Vercel Project로 가져온 뒤 다음 값을 사용한다.

| 설정 | 값 |
| --- | --- |
| Framework Preset | Vite |
| Root Directory | `.` (저장소 루트) |
| Install Command | `npm install` |
| Build Command | `npm run build` |
| Output Directory | `client/dist` |
| Production Branch | `deploy_vercel` |
| Node.js Version | 20.x 이상 |

루트의 [`vercel.json`](../vercel.json)은 다음을 담당한다.

- `client/dist` 프론트엔드 빌드 배포
- `/api/...` 요청을 `api/index.js` Express Function으로 전달
- AI SSE 스트리밍을 위한 Function 최대 실행 시간 설정
- `deploy_vercel` 이외 브랜치의 Git 자동 배포 차단

```text
renewal -> main -> deploy_vercel -> Vercel Production
```

## 3. Vercel 환경변수

### 브라우저에 포함되는 공개 변수

| 변수 | 값 |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase Project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon/publishable key |

프론트엔드와 API가 같은 Vercel origin을 사용하므로 Production에는
`VITE_API_URL`을 등록하지 않는다. 브라우저는 상대 경로 `/api/...`를
호출한다.

### Vercel Function 서버 전용 변수

| 변수 | 필수 | 값 |
| --- | --- | --- |
| `DATABASE_URL` | 예 | Supabase transaction pooler URL |
| `DATABASE_SSL` | 예 | `true` |
| `SUPABASE_URL` | 예 | Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 예 | Supabase service role/secret key |
| `OPENAI_API_KEY` | 채팅 사용 시 | 서버 전용 OpenAI API key |
| `OPENAI_CHAT_MODEL` | 예 | `gpt-5.6-terra` |
| `OPENAI_EMBEDDING_MODEL` | 예 | `text-embedding-3-small` |
| `NCBI_EMAIL` | 권장 | NCBI 요청 식별용 이메일 |
| `NCBI_API_KEY` | 권장 | NCBI API key |
| `NCBI_TOOL` | 예 | `publium` |

`SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `OPENAI_API_KEY`,
`NCBI_API_KEY`에는 절대로 `VITE_` 접두어를 붙이지 않는다.

`DATABASE_URL`은 서버리스 연결 수를 줄이기 위해 Supabase transaction
pooler 주소를 권장한다. 비밀번호가 포함된 연결 문자열은 URL encoding된
Dashboard 제공 값을 사용한다.

`CLIENT_ORIGIN`은 같은 Vercel deployment에서 호출할 때 필요하지 않다.
별도 허용 origin이 필요한 경우에만 쉼표로 구분해 등록한다.

## 4. 배포

`main` 검증이 끝났을 때만 `deploy_vercel`을 fast-forward하고 푸시한다.

```bash
git switch deploy_vercel
git merge --ff-only main
git push origin deploy_vercel
```

`vercel.json`의 `git.deploymentEnabled` 설정 때문에 `renewal`과 `main`
푸시는 Vercel deployment를 생성하지 않는다. Vercel Project의 Production
Branch도 반드시 `deploy_vercel`로 설정한다.

## 5. 배포 후 검증

1. `https://<VERCEL_DOMAIN>/api/health`가 HTTP 200과
   `{"status":"ok"}`를 반환하는지 확인한다.
2. 랜딩과 대시보드 정적 자산이 정상 로드되는지 확인한다.
3. Google 로그인 후 Vercel 도메인으로 정상 복귀하는지 확인한다.
4. PubMed 검색 결과와 초록이 Supabase에 저장되는지 확인한다.
5. 논문 1~5편을 선택해 채팅방을 만들 수 있는지 확인한다.
6. AI 답변이 SSE로 스트리밍되고 선택 논문만 근거로 사용하는지 확인한다.
7. Vercel Function 로그에 access token, API key, DB URL이 출력되지 않는지
   확인한다.

## 6. 롤백

Vercel Deployments에서 직전 정상 deployment를 선택해
**Promote to Production**한다. DB 스키마 변경은 자동 실행하지 않으므로,
애플리케이션 롤백과 Supabase migration 롤백을 분리한다.

비밀값이 로그나 Git에 노출되면 단순 재배포로 끝내지 말고 해당 키를 즉시
회전한 다음 Vercel 환경변수를 갱신한다.
