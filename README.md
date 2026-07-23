# PubMed 논문 분석 · AI 챗봇

PubMed 논문을 수집·분석하고, 저장된 논문을 근거로 질문에 답하는 웹 애플리케이션입니다.

> 이 문서는 A·B의 구현 전 인터페이스와 역할을 맞추기 위한 팀 논의 초안입니다.

## 확정된 방향

- 웹 UI는 Streamlit 대신 **HTML/CSS/Vanilla JavaScript**로 구현한다.
- Python으로 이미 작성한 수집·DB·분석 로직을 재사용하기 위해 백엔드는 **FastAPI**로 구성한다.
- 화면은 단일 페이지의 사이드바와 3개 탭(개요 / 논문 목록 / AI 챗봇)으로 만든다.
- DB는 파일 하나로 관리하기 쉬운 **SQLite**를 사용하며, PMID를 고유 키로 중복을 방지한다.
- 디자인은 **Claymorphism**: 부드러운 파스텔 배경, 둥근 카드, 절제된 입체 그림자 스타일로 한다.
- Google OAuth, 챗봇 토큰 스트리밍, 배포는 필수 요구사항 완료 뒤 진행하는 도전 과제로 둔다.

## 기술 스택

| 영역 | 선택 | 용도 |
| --- | --- | --- |
| Backend | FastAPI + Uvicorn | Python `core` 모듈 연결, JSON API, SSE 스트리밍 |
| Frontend | HTML + CSS + Vanilla JS | 화면과 상호작용을 자유롭게 구현 |
| Template | Jinja2 | 초기 HTML 페이지 제공 |
| Database | SQLite | 논문 데이터 영속화 및 PMID 중복 방지 |
| PubMed API | `requests` + XML 파서 | ESearch 및 EFetch 호출 |
| AI | LangChain + OpenAI | 논문 근거 기반 챗봇 및 대화 이력 |
| Auth (선택) | Authlib + Google OAuth | Google 로그인 |
| Chart | Chart.js | 연도별·저널별 차트 |

## 제안 폴더 구조

```text
team-pubmed/
├── main.py                 # FastAPI 앱, 페이지/API 라우트 (B)
├── core/                   # 데이터 파이프라인 (A)
│   ├── pubmed.py           # ESearch + EFetch 수집
│   ├── db.py               # SQLite 저장·검색·통계
│   └── analysis.py         # 연도별/저널별 분석
├── services/               # AI 서비스 (B)
│   ├── chatbot.py          # LangChain 체인, 대화 이력, 스트리밍
│   └── guard.py            # 의료 조언 차단 정책
├── templates/
│   └── index.html          # 단일 페이지 레이아웃 (B)
├── static/
│   ├── css/style.css       # Claymorphism 디자인 (B)
│   └── js/
│       ├── app.js          # 수집·통계·목록 렌더링 (B)
│       └── chat.js         # 챗봇 SSE 수신/렌더링 (B)
├── auth.py                 # Google OAuth 도전 과제 (B)
├── requirements.txt
├── .env.example
└── README.md
```

## 역할 분담

| 담당 | 범위 |
| --- | --- |
| A — 데이터/백엔드 코어 | `core/pubmed.py`, `core/db.py`, `core/analysis.py` 구현 및 테스트 |
| B — 웹/AI | `main.py`, `services/`, `templates/`, `static/`, OAuth, 화면·챗봇 통합 |
| 공동 | 함수/API 계약 확정, 통합 테스트, README·시연 자료 작성 |

## Core 함수 계약 (A 구현)

```python
# core/pubmed.py
def collect(keyword: str, year_from: int, year_to: int, max_count: int) -> list[dict]: ...

# 반환되는 논문 데이터 형식
# {
#   "pmid": str,
#   "title": str,
#   "abstract": str,
#   "journal": str,
#   "pub_year": int | None,
#   "authors": str,
# }

# core/db.py
def init_db() -> None: ...
def upsert_papers(papers: list[dict]) -> tuple[int, int]: ...  # (신규 수, 스킵 수)
def search_papers(
    keyword: str = "",
    year_from: int | None = None,
    year_to: int | None = None,
    journal: str = "",
    limit: int = 100,
) -> list[dict]: ...
def count_papers() -> int: ...
def count_journals() -> int: ...

# core/analysis.py
def papers_by_year(papers: list[dict]) -> dict[int, int]: ...
def top_journals(papers: list[dict], n: int = 10) -> list[tuple[str, int]]: ...
```

### SQLite 스키마 및 검색 규칙 — 확정

```sql
CREATE TABLE IF NOT EXISTS papers (
  pmid         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  abstract     TEXT NOT NULL DEFAULT '',
  journal      TEXT NOT NULL DEFAULT '',
  pub_year     INTEGER,
  authors      TEXT NOT NULL DEFAULT '',
  collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_papers_year ON papers(pub_year);
CREATE INDEX IF NOT EXISTS idx_papers_journal ON papers(journal);
```

- `pmid`를 기준으로 중복은 저장하지 않고 스킵 수에 포함한다.
- `keyword`는 제목 또는 초록에서 대소문자 구분 없이 검색한다.
- 연도 범위는 양 끝값을 포함한다. 빈 값은 해당 조건을 적용하지 않는다.
- `journal`은 UI에서 선택한 저널명과 정확히 일치하는 결과만 반환한다.
- 최신 연도·PMID 순으로 최대 100건을 반환한다. 페이지네이션은 첫 버전 범위에서 제외한다.

## B가 제공할 API 초안

| Method | Endpoint | 요청 / 응답 요약 |
| --- | --- | --- |
| `POST` | `/api/collect` | 수집 조건 입력 → 신규/스킵/전체 수 반환 |
| `GET` | `/api/stats` | 논문 수, 저널 수, 연도별 수, 상위 저널 반환 |
| `GET` | `/api/papers` | 키워드·연도·저널 필터를 적용한 논문 목록 반환 |
| `POST` | `/api/chat/stream` | 메시지와 대화 ID 입력 → SSE 토큰 스트림 반환 |

`/api/collect` 요청 예시:

```json
{
  "keyword": "diabetes",
  "year_from": 2020,
  "year_to": 2025,
  "max_count": 100
}
```

### 응답 및 오류 형식 — 확정

논문 목록은 아래처럼 결과 배열과 전체 수를 함께 반환한다.

```json
{
  "papers": [{
    "pmid": "12345678",
    "title": "Paper title",
    "abstract": "Abstract text",
    "journal": "Journal name",
    "pub_year": 2025,
    "authors": "Kim H, Lee J"
  }],
  "total": 1
}
```

오류는 FastAPI 기본 형식을 통일해 사용한다.

```json
{ "detail": "사용자에게 보여 줄 오류 메시지" }
```

- 잘못된 입력: `400`
- 로그인되지 않은 사용자: `401`
- PubMed/OpenAI 등 외부 서비스 호출 실패: `502`
- 예상하지 못한 서버 오류: `500`

## 화면 구성

```text
사이드바
└─ 키워드 / 시작·종료 연도 / 최대 수집 건수 / 수집 버튼

탭 1. 개요
├─ 논문 수 · 신규 수 · 스킵 수 · 저널 수 지표 카드
├─ 연도별 논문 수 차트
└─ 상위 저널 차트

탭 2. 논문 목록
├─ 키워드 · 연도 · 저널 필터
├─ 논문 목록 테이블 (모바일에서는 카드형 전환)
└─ 현재 필터 결과 CSV 다운로드

탭 3. AI 챗봇
├─ 대화 메시지
├─ 응답 토큰 스트리밍
└─ 답변 근거 PMID 칩/링크
```

논문 목록은 데스크톱(`768px` 초과)에서 필터 가능한 테이블로, 모바일에서는 제목·저널·연도·PMID만 우선 보이는 카드 목록으로 전환한다. CSV 다운로드는 현재 필터 결과 전체를 대상으로 한다.

## 챗봇 동작 원칙

```text
사용자 질문
  → 의료 조언/진단/처방 요청인지 guard.py에서 먼저 검사
  → 차단 대상이면 고정 안내 문구 반환
  → 아니라면 SQLite에서 관련 논문 검색
  → 제목·초록 일부를 LangChain 컨텍스트로 전달
  → OpenAI 응답을 스트리밍하고 PMID 근거를 함께 표시
```

- 챗봇은 의료 진단이나 처방을 제공하지 않고, 저장된 PubMed 논문 정보만 요약한다.
- API 키는 `.env`의 `OPENAI_API_KEY`로 관리하며 커밋하지 않는다.

### 의료 조언 차단 규칙 — 확정

- 사용자가 개인의 증상에 대한 진단, 치료법, 처방, 복용량, 약 변경을 요구하면 체인을 호출하지 않고 차단한다.
- 논문 요약, 질환 연구 동향, 키워드 기반 논문 탐색은 허용한다.
- 차단 문구: `의료적 진단·처방·복용 방법은 안내할 수 없습니다. 의료 전문가와 상담해 주세요. 대신 PubMed 논문 검색과 연구 정보 요약은 도와드릴 수 있습니다.`

## 디자인 가이드 — Claymorphism

| 요소 | 방향 |
| --- | --- |
| 배경 | 아주 연한 라벤더에서 민트로 이어지는 그라데이션 |
| 카드 | 크림 화이트, 24px 내외 라운드, 부드러운 그림자 |
| 주요색 | Purple `#7C6EE6` |
| 보조색 | Mint `#79D7C5` |
| 강조색 | Peach `#FFB49A` |
| 본문 텍스트 | Deep navy `#2C2B3D` |
| 상호작용 | 버튼 hover 시 살짝 떠오르고 클릭 시 눌리는 효과 |

가독성을 위해 과도한 투명도·블러는 피하고, 입체 효과는 카드와 주요 버튼에만 사용한다.

## 구현 순서

1. A와 함수 계약 및 SQLite 스키마를 확정한다.
2. B는 더미 데이터로 `index.html`, `style.css`, `app.js` 화면을 먼저 만든다.
3. A의 `core` 모듈을 B의 `main.py` API에 연결한다.
4. 통계·목록·CSV 기능을 통합 테스트한다.
5. 챗봇과 의료 조언 차단을 연결한다.
6. 필수 요구사항을 검증한 뒤 OAuth, SSE 고도화, 배포를 진행한다.

## 로컬 실행 (B 브랜치)

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn main:app --reload
```

`.env`에 OpenAI 및 Google OAuth 값을 입력한 뒤 `http://127.0.0.1:8000`으로 접속한다.

## 도전 과제 범위 — 확정

### Google OAuth

- Google 로그인은 최종 제출 범위에 포함한다.
- Authlib로 구현하며, Google 계정의 이메일·표시 이름만 세션에 보관한다.
- 로그인 성공 후 메인 화면으로 이동하고, 로그아웃 기능을 제공한다.
- 첫 버전은 별도 사용자 테이블·권한 등급을 만들지 않는다.

### 배포

- 배포는 최종 제출 범위에 포함한다.
- 배포 환경에서도 SQLite 파일이 유지되도록 영속 디스크(Volume)를 연결할 수 있는 Python 호스팅을 사용한다.
- `DATABASE_PATH`, `OPENAI_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`은 배포 환경 변수로 설정한다.
- 배포 URL을 Google OAuth 승인 리디렉션 URI에 등록하고, 실제 로그인·수집·챗봇 흐름을 점검한다.

## 결정 완료

- [x] SQLite 테이블 컬럼과 `search_papers()`의 검색 조건 확정
- [x] API 응답의 논문 필드 및 오류 형식 확정
- [x] 논문 목록의 데스크톱 테이블 / 모바일 카드 전환 범위 확정
- [x] 의료 조언 차단 문구와 조건 확정
- [x] OAuth와 배포를 최종 제출 범위에 포함
