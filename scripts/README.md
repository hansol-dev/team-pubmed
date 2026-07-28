# SQLite → Supabase 데이터 이관

`migrate_sqlite_to_supabase.py`는 기존 `pubmed.db`를 **읽기 전용**으로 열고,
`supabase/schema.sql`이 적용된 PostgreSQL로 데이터를 옮깁니다. 기본 실행은
dry-run이며 `--apply`를 명시한 경우에만 PostgreSQL에 씁니다.

## 매핑

| SQLite | PostgreSQL |
| --- | --- |
| `papers` | `pubmed_records` |
| `user_papers` | `user_paper_collections` |
| `user_paper_collection_keywords` | `search_runs`, `search_run_papers` |
| `user_collection_trend` | `search_runs.request_params.papers_by_year` |
| `chat_messages.conversation_id` | `chat_rooms`, `chat_messages` |

논문의 초록과 메타데이터는 `pubmed_records`에 저장됩니다. 대상 PMID가 이미
존재하면 기존 값을 우선하며, 대상의 초록·저자·저널·연도가 비어 있을 때만
레거시 값으로 보강합니다.

레거시 `user_id`는 이메일 문자열이므로
`user_profiles.legacy_user_key = lower(trim(email))`을 통해 Supabase UUID로
매핑합니다. 대응 프로필이 없는 사용자의 소유 데이터는 생성하지 않고,
dry-run/apply 보고서의 `missing_profile_keys`와 `skipped`에 표시합니다.

검색 이력, 채팅방, 채팅 메시지에는 레거시 키로부터 생성한 결정론적 UUID를
사용합니다. 모든 INSERT는 충돌 시 건너뛰므로 같은 원본으로 여러 번 실행해도
중복 행이 생기지 않습니다.

## 준비

1. Supabase에 `supabase/schema.sql`을 먼저 적용합니다.
2. 기존 사용자가 Supabase Auth에 가입해 `user_profiles`가 생성됐는지
   확인합니다.
3. PostgreSQL 드라이버를 설치합니다.

```powershell
python -m pip install "psycopg[binary]>=3.1"
```

Supabase의 직접 연결 문자열 또는 session pooler 연결 문자열을
`DATABASE_URL`에 지정합니다. 비밀번호가 포함되므로 커맨드라인 인자로
넘기거나 저장소에 기록하지 마세요.

```powershell
$env:DATABASE_URL = "postgresql://..."
```

## 실행

먼저 dry-run으로 대상 스키마, 사용자 매핑과 이전 예정 건수를 확인합니다.
dry-run도 사용자 UUID를 조회해야 하므로 `DATABASE_URL`이 필수입니다.

```powershell
python scripts/migrate_sqlite_to_supabase.py
```

다른 SQLite 파일을 확인하려면:

```powershell
python scripts/migrate_sqlite_to_supabase.py --sqlite C:\backup\pubmed.db
```

보고서에 예상치 못한 skip이 없음을 확인한 뒤 적용합니다.

```powershell
python scripts/migrate_sqlite_to_supabase.py --apply
```

스크립트는 적용 작업 전체를 한 트랜잭션으로 실행합니다. 오류가 발생하면
PostgreSQL 변경을 롤백합니다. SQLite는 항상 URI `mode=ro`로 열기 때문에
수정되지 않습니다.

## 검증

단위 테스트는 외부 DB 없이 임시 SQLite로 원본 읽기 전용 동작, 변환,
사용자 누락 보고와 UUID 멱등성을 확인합니다.

```powershell
python -m unittest discover -s scripts/tests -v
```

운영 적용 뒤에는 dry-run을 다시 실행해 계획 건수를 확인하고, Supabase에서
아래 항목을 점검하세요.

- `pubmed_records.abstract`에 기존 초록이 보존되었는지
- 사용자별 `user_paper_collections` 건수가 맞는지
- `search_runs.request_params`에 연도별 추이가 들어갔는지
- 기존 `conversation_id`별로 `chat_rooms`가 생성됐는지
- 같은 명령을 다시 `--apply`해도 행 수가 증가하지 않는지
