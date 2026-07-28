# Publium Renewal 배포 가이드

리뉴얼 배포는 다음 세 경계를 유지한다.

| 계층 | 배포 대상 | 저장하는 값 |
| --- | --- | --- |
| React/Vite 클라이언트 | Vercel | API origin, Supabase URL, anon key |
| Express API | Render (Node.js 20) | DB 접속 정보, service role, OpenAI/NCBI 비밀키 |
| Auth/PostgreSQL/pgvector | Supabase | Google OAuth 설정, RLS 정책, 논문/채팅/RAG 데이터 |

브라우저에는 `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`,
`OPENAI_API_KEY`, `NCBI_API_KEY`를 절대 넣지 않는다. `VITE_` 접두사가
붙은 값은 빌드 결과물에 공개된다는 전제로 취급한다.

## 1. Supabase 준비

### 프로젝트와 스키마

1. Production용 Supabase 프로젝트를 만든다.
2. Supabase Dashboard의 **SQL Editor**에서
   [`supabase/schema.sql`](../supabase/schema.sql)을 전체 실행한다.
3. SQL 실행 결과에서 `vector`, `pgcrypto` extension 생성 여부를 확인한다.
4. Table Editor에서 `pubmed_records`, `user_paper_collections`,
   `chat_rooms`, `chat_room_papers`, `chat_messages`, `paper_documents`,
   `paper_chunks`가 생성됐는지 확인한다.
5. `paper_chunks.embedding`이 `vector(1536)`이고 HNSW 인덱스가
   생성됐는지 확인한다. 이 차원은 기본
   `text-embedding-3-small` 모델과 연결되어 있으므로 모델/차원을
   바꾸려면 스키마도 함께 마이그레이션해야 한다.

스키마는 모든 애플리케이션 테이블에 RLS를 활성화한다. 로그인한 사용자는
자신의 검색 기록, 컬렉션, 채팅방과 메시지만 읽고 쓸 수 있다. 공유 논문
메타데이터는 로그인 사용자가 읽을 수 있지만, PubMed upsert 및 PMC 원문
가공은 Render의 service role만 수행한다. 배포 후 Supabase의
**Database > Policies**에서 RLS가 꺼진 public 테이블이 없는지 다시
확인한다.

### Google Auth

1. Google Cloud Console에서 Web OAuth client를 만든다.
2. Google OAuth client의 **Authorized redirect URI**에 Supabase가
   안내하는 callback을 등록한다.

   ```text
   https://<SUPABASE_PROJECT_REF>.supabase.co/auth/v1/callback
   ```

3. Supabase **Authentication > Providers > Google**에서 Google client
   ID와 secret을 등록하고 provider를 활성화한다.
4. Supabase **Authentication > URL Configuration**에서 다음을
   설정한다.

   - Site URL: `https://<VERCEL_PRODUCTION_DOMAIN>`
   - Redirect URLs:
     `http://localhost:5173/**`,
     `https://<VERCEL_PRODUCTION_DOMAIN>/**`
   - Vercel Preview 로그인이 필요하면
     `https://*-<VERCEL_TEAM_OR_ACCOUNT>.vercel.app/**`도 추가한다.

Preview wildcard는 해당 Vercel 계정 범위로 좁힌다. 임의의 외부 도메인을
허용하지 않는다. 커스텀 도메인을 붙인 뒤에는 Site URL과 허용 redirect에
커스텀 도메인을 추가한다.

### Supabase에서 복사할 값

- Project URL → Vercel의 `VITE_SUPABASE_URL`, Render의 `SUPABASE_URL`
- Project API anon/publishable key → Vercel의
  `VITE_SUPABASE_ANON_KEY`
- Project API service role/secret key → Render의
  `SUPABASE_SERVICE_ROLE_KEY`
- PostgreSQL connection string → Render의 `DATABASE_URL`

`DATABASE_URL`은 Render와 IPv4 환경에서 안정적인 Supabase transaction
pooler 문자열을 우선 사용한다. 비밀번호의 특수문자는 URL encoding된
문자열을 Dashboard에서 그대로 복사한다. API가 장기 트랜잭션이나 세션
기능을 필요로 하도록 바뀌면 session pooler/direct connection 사용 여부를
별도로 검토한다. 현재 서버는 `pg` pool을 사용하며
`DATABASE_SSL=true`를 기대한다.

## 2. Render Express API 배포

루트의 `render.yaml`은 `renewal` 브랜치를 Node.js 20 서비스로 배포한다.

- Repository root에서 `npm install`
- `npm run start -w server`
- Render가 주입하는 `PORT`로 Express 실행
- Health check: `GET /api/health`
- Auto deploy: `renewal` 브랜치 commit

Render Dashboard에서 Blueprint를 연결하거나 기존 Python 서비스를 새
설정으로 교체한다. Production API를 즉시 교체해야 하는 상황이 아니라면
기존 Python 서비스를 유지한 채 `publium-api`를 먼저 생성하고 검증한 뒤
프론트의 API 주소를 바꾸는 방식이 안전하다.

### Render 환경변수

| 변수 | 필수 | 값/설명 |
| --- | --- | --- |
| `NODE_VERSION` | 예 | `20.19.4` |
| `NODE_ENV` | 예 | `production` |
| `DATABASE_URL` | 예 | Supabase PostgreSQL pooler URL |
| `DATABASE_SSL` | 예 | `true` |
| `CLIENT_ORIGIN` | 예 | 허용할 Vercel origin |
| `SUPABASE_URL` | 예 | Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 예 | 서버 전용 service role/secret key |
| `OPENAI_API_KEY` | 챗봇에 필수 | 서버 전용 OpenAI key |
| `OPENAI_CHAT_MODEL` | 예 | 기본 `gpt-5.6-terra` |
| `OPENAI_EMBEDDING_MODEL` | 예 | 기본 `text-embedding-3-small` |
| `NCBI_EMAIL` | 권장 | NCBI 요청 식별용 운영 이메일 |
| `NCBI_API_KEY` | 권장 | NCBI rate limit 완화용 key |
| `NCBI_TOOL` | 예 | `publium` |

`CLIENT_ORIGIN`은 쉼표로 여러 origin을 받을 수 있다.

```text
https://publium.example.com,https://publium.vercel.app
```

공백은 허용되지만 `*`는 사용하지 않는다. 서버는 bearer token을 받으며
CORS credentials도 활성화하므로 실제 Vercel/커스텀 origin을 정확히
등록해야 한다. Preview URL을 매 배포마다 허용하는 대신 안정적인 Preview
alias를 쓰거나, 검증할 특정 Preview origin을 일시적으로 추가한다.

배포 후 먼저 인증 없는 health endpoint를 확인한다.

```powershell
Invoke-RestMethod https://<RENDER_SERVICE>.onrender.com/api/health
```

그다음 브라우저 로그인으로 받은 Supabase access token을
`Authorization: Bearer <token>`에 넣어 보호 API가 응답하는지 확인한다.
service role key 자체를 bearer token으로 클라이언트에서 보내면 안 된다.

## 3. Vercel React/Vite 배포

Vercel에서 같은 Git 저장소를 import하고 다음 값을 설정한다.

| 설정 | 값 |
| --- | --- |
| Framework Preset | Vite |
| Root Directory | `client` |
| Install Command | `npm install` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Production Branch | `deploy_vercel` |

`client/vercel.json`은 Git 자동 배포를 `deploy_vercel` 브랜치에만 허용한다.
따라서 `renewal`과 `main` 푸시는 Vercel 배포를 만들지 않으며, 검증된 `main`을
`deploy_vercel`에 반영해 푸시할 때만 새 Production 배포가 생성된다.

```text
renewal -> main -> deploy_vercel -> Vercel Production
```

Vercel 환경변수:

| 변수 | 값 | 노출 범위 |
| --- | --- | --- |
| `VITE_API_URL` | `https://<RENDER_SERVICE>.onrender.com` | 공개 |
| `VITE_SUPABASE_URL` | Supabase Project URL | 공개 |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon/publishable key | 공개 |

`VITE_API_URL` 끝에는 `/api`를 붙이지 않는다. 클라이언트가 각 경로에
`/api/...`를 추가한다. 값 변경 후에는 Vite가 빌드 시 환경변수를
주입하므로 반드시 Redeploy한다.

Production과 Preview 환경변수를 분리할 수 있다. Preview도 같은 Supabase
Production DB를 사용하면 실제 사용자 데이터에 영향을 줄 수 있으므로,
위험한 스키마 변경을 검증할 때는 별도 Supabase staging 프로젝트와 별도
Render staging API를 권장한다.

## 4. 권장 배포 순서

1. Supabase 프로젝트를 만들고 `supabase/schema.sql`을 적용한다.
2. Google provider, Site URL, redirect allowlist를 설정한다.
3. Render `publium-api`를 생성하고 모든 서버 환경변수를 등록한다.
4. `/api/health`와 DB 연결 상태를 확인한다.
5. Vercel 프로젝트를 `client` Root Directory로 배포한다.
6. 확정된 Vercel production origin을 Render `CLIENT_ORIGIN`에 등록하고
   Render를 재배포한다.
7. Supabase Site URL/redirect에 확정 도메인을 반영한다.
8. 아래 smoke test를 모두 통과시킨 후 기존 서비스 트래픽을 전환한다.

Vercel 주소가 정해지기 전 Render를 띄워야 한다면 `CLIENT_ORIGIN`에 예상
production domain을 먼저 넣고, 실제 주소가 결정된 직후 수정한다.

## 5. 배포 검증 체크리스트

- [ ] Render `/api/health`가 HTTP 200을 반환한다.
- [ ] 허용되지 않은 origin의 API 요청은 CORS에서 차단된다.
- [ ] Google 로그인 후 Vercel 앱으로 정상 복귀한다.
- [ ] 로그아웃 상태에서 보호 API 호출이 401을 반환한다.
- [ ] PubMed 검색 결과가 화면에 나타난다.
- [ ] 검색한 PMID가 `pubmed_records`에 중복 없이 upsert된다.
- [ ] 검색 시 제목, 초록, DOI, PMCID가 가능한 범위에서 저장된다.
- [ ] 같은 PMID를 다시 검색하면 비어 있던 초록/식별자가 보강된다.
- [ ] 사용자가 저장한 논문만 해당 사용자의 컬렉션에 보인다.
- [ ] 다른 계정의 컬렉션/채팅방/메시지를 읽을 수 없다.
- [ ] PubMed, PMC, DOI 원문 버튼이 실제 제공 상태와 일치한다.
- [ ] 1~5편을 선택해 채팅방을 만들 수 있고 6편은 거부된다.
- [ ] PMC 공개 원문은 한 번 가공된 뒤 `paper_documents`와
      `paper_chunks`를 재사용한다.
- [ ] PMC 원문이 없는 논문은 `abstract_only`로 표시된다.
- [ ] 채팅 SSE가 토큰을 스트리밍하고 선택 논문 근거만 인용한다.
- [ ] Render 로그와 Vercel 로그에 access token/API key/DB URL이
      출력되지 않는다.

## 6. 롤백

배포 전 다음 정보를 남긴다.

- 현재 Vercel Production deployment URL
- 현재 Render 배포 commit과 기존 Python 서비스 URL
- 적용 전 Supabase schema migration/version
- 환경변수 이름 목록(값은 문서나 Git에 기록하지 않음)

문제가 생기면 다음 순서로 되돌린다.

1. Vercel에서 직전 정상 deployment를 **Promote to Production**한다.
2. 구 프론트가 사용하는 기존 Python API가 살아 있는지 `/health`로
   확인하고, 필요하면 프론트 API 환경변수도 이전 URL로 복원해 재배포한다.
3. Render renewal API는 트래픽에서 분리한다. 데이터 보존을 위해 서비스와
   Supabase 테이블을 즉시 삭제하지 않는다.
4. DB 변경은 자동으로 SQL을 역실행하지 않는다. additive migration이면
   새 테이블/컬럼을 둔 채 애플리케이션만 롤백한다. destructive migration
   롤백은 사전 백업과 검증된 down migration이 있을 때만 실행한다.
5. Supabase Dashboard에서 Auth redirect Site URL을 구 production
   도메인으로 복원한다.
6. 장애 원인과 실패한 commit을 기록한 뒤 staging에서 수정본을 검증한다.

`SUPABASE_SERVICE_ROLE_KEY`, OpenAI key, DB 비밀번호가 브라우저 번들,
로그 또는 Git에 노출된 경우에는 단순 롤백으로 끝내지 않고 해당 키를 즉시
회전하고 Render/Vercel 환경변수를 갱신한다.
