# Publium Renewal

PubMed 논문 검색, 메타데이터·초록 저장, 공개 원문 접근, 선택 논문 기반
AI 대화를 제공하는 연구 워크스페이스입니다.

현재 애플리케이션은 기존 Publium의 디자인을 유지하면서 배포 구조를
다음과 같이 전환합니다.

| 영역 | 기술 | 배포 |
| --- | --- | --- |
| Frontend | React 19, Vite | Vercel |
| Backend | Node.js 20, Express | Render |
| Auth / DB | Supabase Auth, PostgreSQL, pgvector | Supabase |
| Research API | NCBI PubMed E-utilities, PMC | NCBI |
| AI | OpenAI Chat Completions, Embeddings, SSE | Render API |

## 주요 기능

- 키워드와 연도로 PubMed 논문 검색
- PMID 기준 공용 메타데이터 중복 제거
- 검색 시 제목, 초록, 저자, 저널, DOI, PMCID 즉시 저장·갱신
- 사용자별 논문 컬렉션과 검색 이력
- PubMed, DOI 출판사 페이지, PMC 무료 원문 링크 구분
- 최대 5편을 선택해 전용 채팅방 생성
- PMC 공개 원문 최초 1회 수집 및 섹션별 청킹
- pgvector 유사도 검색과 초록 fallback
- 선택한 논문만 근거로 사용하는 SSE 스트리밍 챗봇
- Google OAuth와 PostgreSQL RLS를 통한 사용자 데이터 격리

유료 출판사 본문은 크롤링하거나 저장하지 않습니다. PMCID와 명시적인
재사용 라이선스가 확인된 PMC 문서만 원문 분석 대상으로 저장하며, 그렇지
않은 논문은 DB에 저장된 초록으로 분석합니다.

## 프로젝트 구조

```text
team-pubmed/
├── client/                 # React/Vite frontend
├── server/                 # Express API, PubMed/PMC, OpenAI
├── supabase/
│   └── schema.sql          # PostgreSQL, RLS, pgvector schema
├── docs/
│   ├── renewal-architecture.md
│   └── deployment-renewal.md
├── templates/              # 기존 디자인 기준 Jinja 화면
├── static/                 # 기존 디자인 기준 CSS/JavaScript
└── tests/                  # 기존 FastAPI 회귀 테스트
```

기존 FastAPI/Jinja 구현은 리뉴얼의 디자인·동작 비교 기준으로 보존합니다.

## 로컬 실행

### 1. 설치

```bash
npm install
```

### 2. 환경변수

```bash
copy client\.env.example client\.env
copy server\.env.example server\.env
```

`client/.env`:

```dotenv
VITE_API_URL=http://localhost:4000
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

`server/.env`:

```dotenv
PORT=4000
CLIENT_ORIGIN=http://localhost:5173
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
DATABASE_URL=postgresql://...
DATABASE_SSL=true
OPENAI_API_KEY=your-openai-key
NCBI_EMAIL=your-email
NCBI_API_KEY=your-optional-ncbi-key
```

### 3. Supabase 스키마

새 Supabase 프로젝트의 SQL Editor에서
[`supabase/schema.sql`](supabase/schema.sql)을 실행합니다.

### 4. 실행

```bash
npm run dev
```

- Frontend: <http://localhost:5173>
- API health: <http://localhost:4000/api/health>

## 검증

```bash
npm run check
npm audit --omit=dev
```

`npm run check`는 Express 단위·API 테스트와 React 프로덕션 빌드를
실행합니다.

## 배포

- Vercel Root Directory: `client`
- Render Blueprint: `render.yaml`
- Supabase schema: `supabase/schema.sql`

환경변수, OAuth redirect, CORS, 배포 순서와 롤백 절차는
[`docs/deployment-renewal.md`](docs/deployment-renewal.md)를 참고하세요.
