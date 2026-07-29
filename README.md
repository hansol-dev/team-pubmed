# Publium

PubMed 논문을 검색·수집하고, 선택한 논문의 초록이나 공개 전문을 근거로
AI와 대화하는 연구 워크스페이스입니다. 기존 Publium 디자인은 유지하면서
React, Express, Supabase, Vercel 구조로 리뉴얼했습니다.

## 기술 구성

| 영역 | 기술 | 실행 환경 |
| --- | --- | --- |
| Frontend | React 19, Vite | Vercel Static Build |
| Backend | Node.js 22, Express | Vercel Function |
| Auth / DB | Supabase Auth, PostgreSQL, pgvector | Supabase |
| 논문 데이터 | PubMed E-utilities, PMC, BioC | NCBI |
| 원문 탐색 | PMC OA, Unpaywall, Crossref | 외부 API |
| AI | OpenAI Chat, Embeddings, SSE | Vercel Function |

## 주요 기능

- 키워드·연도 범위로 PubMed 논문 검색
- 검색 즉시 제목, 저자, 저널, 초록, DOI, PMCID 저장
- 사용자별 논문 컬렉션·검색 이력·채팅방 분리
- 최대 5편을 선택해 여러 논문을 함께 분석
- PMC 공개 전문 자동 수집과 사용자 PDF 업로드
- 논문 원문과 채팅을 나란히 보는 Paper Reader
- 답변 근거 문단 표시와 원문 하이라이트
- SSE 기반 AI 답변 스트리밍
- Google OAuth 로그인과 PostgreSQL RLS
- `is_del` 기반 소프트 삭제

## RAG 동작 방식

Publium 챗봇은 RAG 방식입니다.

```text
논문 검색
  → 초록 저장
  → 공개 전문 탐색 또는 PDF 업로드
  → 본문 청킹·임베딩·DB 저장
  → 질문과 관련된 논문 조각 검색
  → 검색한 근거와 질문을 AI에 전달
  → 답변과 출처 문단 표시
```

논문 전문은 다음 순서로 사용합니다.

```text
사용자 업로드 PDF
  → 저장된 PMC 공개 전문
  → PMC XML
  → BioC 본문
  → 저장된 초록
```

- PMC 전문은 공개 라이선스를 확인한 뒤 공용 문서로 한 번만 저장합니다.
- Unpaywall과 Crossref는 공개 원문·PDF 위치를 찾는 데 사용합니다.
- 출판사 페이지와 권리가 확인되지 않은 PDF는 자동 수집하지 않습니다.
- 전문을 확보하지 못한 논문은 저장된 초록만 근거로 답변합니다.
- 업로드 PDF는 최대 25MB·2,000페이지이며 사용자 계정별로 분리됩니다.
- 스캔 이미지 PDF는 현재 OCR을 지원하지 않습니다.

### 벡터 저장과 검색

별도의 Pinecone 같은 벡터 DB를 두지 않고, Supabase PostgreSQL의
`pgvector` 확장을 벡터 저장소로 사용합니다.

전문을 실제로 확보하면 다음과 같이 처리합니다.

1. PMC XML·BioC 본문 또는 업로드 PDF 텍스트를 섹션별로 정리합니다.
2. 본문을 최대 약 4,200자 단위로 나누고, 문맥이 끊기지 않도록 청크마다
   약 400자를 겹칩니다.
3. 각 청크를 `text-embedding-3-small`의 1,536차원 벡터로 변환합니다.
4. 원문 청크, 섹션, 임베딩 모델과 벡터를 PostgreSQL에 저장합니다.

| 문서 종류 | 원문 저장 | 청크·벡터 저장 | 범위 |
| --- | --- | --- | --- |
| PMC 공개 전문 | `paper_documents` | `paper_chunks` | 모든 사용자가 재사용하는 공용 캐시 |
| 사용자 PDF | `user_paper_documents` | `user_paper_chunks` | 업로드한 사용자 전용 |

질문할 때는 질문도 같은 모델로 임베딩하고, `pgvector`의 코사인 거리로
가까운 청크를 검색합니다. 논문별로 관련 청크를 최대 2개씩 고르고, 기본
요청에서는 전체 약 10개 이내의 근거와 각 논문의 제목·초록을 AI에
전달합니다. HNSW 인덱스로 벡터 검색 속도를 높입니다.

OpenAI 임베딩 호출이나 pgvector 검색을 사용할 수 없을 때는 요청을
실패시키지 않고 논문별 앞쪽 청크를 순서대로 가져오는 방식으로
대체합니다. 이 경우 의미 유사도 검색보다 근거 선택 정확도가 낮을 수
있습니다.

원문 링크 발견과 벡터 저장은 별개입니다.

- PMC XML·BioC 본문 확보: 자동 청킹·임베딩
- 사용자 PDF 업로드: 자동 청킹·임베딩
- Unpaywall·Crossref 링크만 발견: 링크 후보만 저장하고 자동 임베딩하지 않음
- 초록만 확보: 제목·서지정보·초록을 대화 근거로 사용하지만 전문처럼
  벡터 청킹하지 않음

## 프로젝트 구조

```text
team-pubmed/
├── api/                    # Vercel Function 진입점
├── client/                 # React/Vite 프론트엔드
├── server/                 # Express, PubMed/PMC, RAG, OpenAI
├── supabase/
│   └── schema.sql          # PostgreSQL, RLS, pgvector, Storage 정책
├── docs/                   # 아키텍처와 배포 문서
├── scripts/                # DB 적용·검증 스크립트
├── templates/              # 기존 화면 비교 기준
├── static/                 # 기존 화면 비교 기준
└── tests/                  # 기존 구현 회귀 테스트
```

기존 FastAPI/Jinja 구현은 디자인과 동작 비교 기준으로 보존합니다. 현재
배포 애플리케이션은 `client/`, `server/`, `api/`를 사용합니다.

## 로컬 실행

### 1. 준비

- Node.js 22
- npm
- Supabase 프로젝트
- OpenAI API key

```powershell
npm install
Copy-Item client\.env.example client\.env
Copy-Item server\.env.example server\.env
```

루트 `.env.example`은 환경변수 경계를 설명하는 안내 파일입니다. 실제
개발 서버는 `client/.env`와 `server/.env`를 각각 읽습니다.

### 2. Supabase 적용

Supabase SQL Editor에서 [`supabase/schema.sql`](supabase/schema.sql)을
실행합니다. 이 스키마에는 pgvector, RLS, 논문 문서·청크 테이블과 비공개
`paper-pdfs` Storage bucket 정책이 포함되어 있습니다.

### 3. 환경변수

클라이언트의 필수 공개 변수:

```dotenv
VITE_API_URL=
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-or-publishable-key
```

로컬과 Vercel 모두 `VITE_API_URL`을 비워 두면 같은 origin의 `/api`를
호출합니다. 로컬에서는 Vite proxy가 요청을 `http://127.0.0.1:4000`으로
전달합니다.

서버의 주요 변수:

```dotenv
PORT=4000
CLIENT_ORIGIN=http://localhost:5173
DATABASE_URL=postgresql://...
DATABASE_SSL=true
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
OPENAI_API_KEY=your-openai-key
OPENAI_CHAT_MODEL=gpt-5.6-terra
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
NCBI_EMAIL=your-email@example.com
NCBI_API_KEY=
NCBI_TOOL=publium
UNPAYWALL_EMAIL=your-email@example.com
DEV_USER_ID=
```

정확한 설명은 [`server/.env.example`](server/.env.example)과
[`client/.env.example`](client/.env.example)을 참고하세요. 서버 비밀값에는
절대로 `VITE_` 접두어를 붙이지 않습니다.

### 4. 실행

```powershell
npm run dev
```

- Frontend: <http://localhost:5173>
- API health: <http://localhost:4000/api/health>

Google 로그인 없이 테스트하려면 Supabase Authentication에
`local-dev@publium.local` 전용 사용자를 만들고, 해당 UUID를
`server/.env`의 `DEV_USER_ID`에 입력한 뒤 다음 주소로 접속합니다.

<http://localhost:5173/?dev=1>

로컬 인증 우회는 개발 모드에서만 작동하며 Vercel에서는 비활성화됩니다.
운영 사용자 UUID를 `DEV_USER_ID`로 사용하면 안 됩니다.

## Google 로그인

Supabase에서 Google provider를 활성화하고 다음 주소를 등록합니다.

```text
Supabase Site URL:
https://<VERCEL_PRODUCTION_DOMAIN>

Supabase Redirect URLs:
http://localhost:5173/**
https://<VERCEL_PRODUCTION_DOMAIN>/**

Google OAuth Authorized redirect URI:
https://<SUPABASE_PROJECT_REF>.supabase.co/auth/v1/callback
```

## 검증

```powershell
npm run check
```

서버 테스트와 클라이언트 프로덕션 빌드를 함께 실행합니다.

## 배포

- Vercel Root Directory: `.`
- Framework Preset: Vite
- Production Branch: `deploy_vercel`
- Function entry: `api/index.js`
- Output Directory: `client/dist`
- Node.js: 22.x

배포 흐름:

```text
renewal → main → deploy_vercel → Vercel Production
```

`vercel.json`에서 `deploy_vercel` 이외 브랜치의 자동 배포를 차단합니다.
환경변수, OAuth, 배포 및 롤백 절차는
[`docs/deployment-renewal.md`](docs/deployment-renewal.md)를 참고하세요.
