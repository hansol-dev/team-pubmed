<div align="center">

# Publium

### Collect papers. See the trend. Ask your library.

PubMed 논문을 한곳에 수집하고 연구 흐름을 분석하며,<br />
내가 모은 논문을 근거로 AI와 대화하는 연구 보조 서비스입니다.

[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![LangChain](https://img.shields.io/badge/LangChain-1.x-1C3C3C?logo=langchain&logoColor=white)](https://www.langchain.com/)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3FCF8E?logo=supabase&logoColor=white)](https://supabase.com/)

[Live Demo](https://publium.onrender.com) · [빠른 시작](#빠른-시작) · [주요 기능](#주요-기능) · [Vercel 전환 계획](docs/VERCEL_MIGRATION.md)

</div>

![Publium 대시보드](docs/images/publium-dashboard.png)

> Render 무료 인스턴스는 일정 시간 요청이 없으면 절전 상태가 됩니다. 첫 접속에는 수십 초가 걸릴 수 있습니다.

## Publium을 만든 이유

PubMed 검색 결과를 매번 다시 찾고, 논문 목록과 연구 동향을 서로 다른 도구에서 관리하는 과정을 줄이기 위해 만들었습니다. Publium은 **논문 수집 → 흐름 분석 → 근거 기반 대화**를 하나의 연구 공간으로 연결합니다.

## 작동 방식

| 1. Collect | 2. Explore | 3. Ask |
| --- | --- | --- |
| 키워드와 연도 범위로 PubMed 논문을 수집합니다. | 연도별 출판 추세와 주요 저널을 시각화합니다. | AI가 내 논문을 직접 검색해 관련 PMID와 함께 답합니다. |

## 주요 기능

- **PubMed 논문 수집** — 키워드, 연도 범위, 최대 수집 건수를 지정해 논문 메타데이터를 가져옵니다.
- **사용자별 연구 공간** — Google 계정별로 수집 논문, 검색 키워드, 분석 추세와 대화 기록을 분리합니다.
- **연구 동향 분석** — 연도별 PubMed 검색 건수와 수집 논문의 상위 저널을 시각화합니다.
- **정교한 논문 검색** — PMID, 제목, 초록, 수집 키워드, 연도와 저널 조건으로 원하는 논문을 찾습니다.
- **대화형 논문 검색** — LangChain 에이전트가 대화 맥락에 맞춰 사용자의 논문을 검색하고 근거 PMID를 제시합니다.
- **중복 방지와 내보내기** — PMID 기준으로 중복 저장을 막고 현재 검색 결과를 CSV로 내려받습니다.

## 기술 구성

| 영역 | 기술 |
| --- | --- |
| Backend | Python, FastAPI, Uvicorn |
| Frontend | Jinja2, HTML, CSS, Vanilla JavaScript |
| Database | SQLite(로컬), Supabase PostgreSQL(배포) |
| Data | NCBI PubMed ESearch / EFetch |
| AI | LangChain, OpenAI |
| Authentication | Authlib, Google OAuth 2.0 |
| Deployment | Render Web Service, Supabase |

```text
Browser
   │
   ▼
FastAPI · Jinja2
   ├── NCBI PubMed API ── 논문 수집과 연도별 검색량
   ├── OpenAI API ─────── 수집 논문 기반 대화
   ├── Google OAuth ───── 사용자 인증
   └── Supabase ───────── 논문·검색 추세·대화 기록
```

## 빠른 시작

### 1. 저장소와 가상환경 준비

```bash
git clone https://github.com/hansol-dev/team-pubmed.git
cd team-pubmed
python -m venv .venv
```

가상환경을 활성화합니다.

```bash
# Git Bash
source .venv/Scripts/activate

# PowerShell
.\.venv\Scripts\Activate.ps1
```

### 2. 의존성과 환경 변수 설정

```bash
python -m pip install -r requirements.txt
cp .env.example .env
```

`.env`에 필요한 값을 입력한 뒤 서버를 실행합니다.

```bash
uvicorn main:app --reload
```

[http://127.0.0.1:8000](http://127.0.0.1:8000)에서 Publium을 확인할 수 있습니다.

## 환경 변수

| 변수 | 필수 여부 | 설명 |
| --- | --- | --- |
| `SESSION_SECRET` | 필수 | 세션 쿠키 서명용 임의 문자열 |
| `DATABASE_URL` | 배포 시 필수 | Supabase PostgreSQL 연결 문자열 |
| `GOOGLE_CLIENT_ID` | 로그인 사용 시 필수 | Google OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | 로그인 사용 시 필수 | Google OAuth 클라이언트 보안 비밀 |
| `OPENAI_API_KEY` | AI 기능 사용 시 필수 | OpenAI API 키 |
| `NCBI_API_KEY` | 선택 | PubMed 요청 한도 향상용 API 키 |
| `NCBI_EMAIL` | 선택 | NCBI 요청 식별용 이메일 |
| `PUBMED_DB_PATH` | 선택 | 로컬 SQLite 경로, 기본값 `pubmed.db` |
| `HTTPS_ONLY` | 배포 시 권장 | HTTPS 환경에서 `true` |

`.env`와 모든 비밀키는 Git에 커밋하지 않습니다.

<details>
<summary><strong>Google OAuth 설정</strong></summary>

Google Cloud Console의 OAuth 클라이언트에 접속 환경별 승인된 리디렉션 URI를 등록합니다.

```text
http://127.0.0.1:8000/auth/callback
http://localhost:8000/auth/callback
https://publium.onrender.com/auth/callback
```

배포 도메인을 변경하면 새 도메인의 `/auth/callback`도 추가해야 합니다.

</details>

<details>
<summary><strong>API 목록</strong></summary>

| Method | Endpoint | 설명 |
| --- | --- | --- |
| `GET` | `/health` | 서비스 상태 확인 |
| `POST` | `/api/collect` | PubMed 논문 수집 |
| `GET` | `/api/stats` | 저장 논문·저널 통계 |
| `GET` | `/api/trend` | 키워드별 연도 추세 |
| `GET` | `/api/papers` | 조건별 논문 검색 |
| `GET` | `/api/metadata` | 수집 논문 목록 |
| `POST` | `/api/papers/reset` | 수집 데이터 초기화 |
| `POST` | `/api/chat/stream` | AI 답변 SSE 스트리밍 |
| `GET` | `/api/chat/history` | 사용자 대화 기록 |
| `DELETE` | `/api/chat/history` | 사용자 대화 기록 삭제 |

FastAPI가 제공하는 `/docs`에서 대화형 API 문서를 확인할 수 있습니다.

</details>

<details>
<summary><strong>프로젝트 구조</strong></summary>

```text
team-pubmed/
├─ core/
│  ├─ analysis.py          # 연도별·저널별 통계
│  ├─ database.py          # SQLite/PostgreSQL 연결
│  ├─ db.py                # 사용자별 논문 저장·검색
│  └─ pubmed.py            # PubMed 수집
├─ services/
│  ├─ chatbot.py           # 논문 검색 에이전트
│  ├─ chat_store.py        # 사용자별 대화 기록
│  └─ guard.py             # 의료 조언 요청 차단
├─ static/                 # CSS, JavaScript
├─ templates/              # 랜딩·대시보드 템플릿
├─ tests/                  # 단위·통합 테스트
├─ auth.py                 # Google OAuth
├─ main.py                 # FastAPI 앱과 API
└─ render.yaml             # Render Blueprint
```

</details>

## 테스트

```bash
python -m unittest discover -s tests -v
```

PubMed 응답 파싱, 데이터베이스 호환성, 사용자별 데이터 격리, 검색과 중복 처리, 통계, OAuth 접근 제어, 대화 기록과 의료 조언 차단을 검증합니다.

## 배포

현재는 **Render Web Service + Supabase PostgreSQL**로 운영합니다. FastAPI 앱을 Vercel Functions로 이전하기 위한 위험 요소, 단계별 작업과 롤백 기준은 [Vercel 전환 계획](docs/VERCEL_MIGRATION.md)에 정리했습니다.

## 주의사항

Publium은 논문 탐색과 연구 보조를 위한 서비스입니다. 의료 전문가의 진단을 대신하지 않으며, AI 답변은 반드시 원문 논문을 통해 다시 확인해야 합니다.
