#!/usr/bin/env python3
"""Safely migrate the legacy Publium SQLite database to Supabase PostgreSQL."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping


MIGRATION_NAMESPACE = uuid.UUID("22f0c98a-1b4e-4ef0-96d1-c997ac636a73")
REQUIRED_SOURCE_TABLES = {
    "papers",
    "user_papers",
    "user_paper_collection_keywords",
    "user_collection_trend",
    "chat_messages",
}
REQUIRED_TARGET_TABLES = {
    "user_profiles",
    "pubmed_records",
    "search_runs",
    "search_run_papers",
    "user_paper_collections",
    "chat_rooms",
    "chat_messages",
}


@dataclass(frozen=True)
class Paper:
    pmid: str
    title: str
    abstract: str
    journal: str
    publication_year: int | None
    authors_json: str
    collected_at: datetime


@dataclass(frozen=True)
class SearchRun:
    id: str
    user_id: str
    legacy_user_key: str
    query: str
    year_from: int | None
    year_to: int | None
    max_results: int
    result_count: int
    stored_count: int
    request_params_json: str
    created_at: datetime
    pmids: tuple[str, ...]


@dataclass(frozen=True)
class Collection:
    user_id: str
    legacy_user_key: str
    pmid: str
    first_search_run_id: str | None
    saved_at: datetime


@dataclass(frozen=True)
class ChatRoom:
    id: str
    user_id: str
    legacy_user_key: str
    conversation_id: str
    title: str
    created_at: datetime
    last_message_at: datetime


@dataclass(frozen=True)
class ChatMessage:
    room_id: str
    user_id: str
    client_message_id: str
    role: str
    content: str
    created_at: datetime


@dataclass
class MigrationPlan:
    papers: list[Paper] = field(default_factory=list)
    search_runs: list[SearchRun] = field(default_factory=list)
    collections: list[Collection] = field(default_factory=list)
    chat_rooms: list[ChatRoom] = field(default_factory=list)
    chat_messages: list[ChatMessage] = field(default_factory=list)
    missing_profile_keys: set[str] = field(default_factory=set)
    skipped: dict[str, int] = field(default_factory=dict)

    def report(self, mode: str) -> dict[str, Any]:
        return {
            "mode": mode,
            "planned": {
                "pubmed_records": len(self.papers),
                "search_runs": len(self.search_runs),
                "search_run_papers": sum(len(run.pmids) for run in self.search_runs),
                "user_paper_collections": len(self.collections),
                "chat_rooms": len(self.chat_rooms),
                "chat_messages": len(self.chat_messages),
            },
            "missing_profile_keys": sorted(self.missing_profile_keys),
            "skipped": dict(sorted(self.skipped.items())),
        }


@dataclass
class LegacySnapshot:
    papers: list[dict[str, Any]]
    user_papers: list[dict[str, Any]]
    keywords: list[dict[str, Any]]
    trends: list[dict[str, Any]]
    messages: list[dict[str, Any]]


def normalize_user_key(value: Any) -> str:
    return str(value or "").strip().casefold()


def parse_legacy_timestamp(value: Any) -> datetime:
    """Interpret SQLite CURRENT_TIMESTAMP values as UTC."""
    text = str(value or "").strip()
    if not text:
        return datetime.now(timezone.utc)
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def parse_authors(value: Any) -> list[str]:
    text = str(value or "").strip()
    if not text:
        return []
    if text.startswith("["):
        try:
            decoded = json.loads(text)
            if isinstance(decoded, list):
                return [str(item).strip() for item in decoded if str(item).strip()]
        except json.JSONDecodeError:
            pass
    return [part.strip() for part in text.split(",") if part.strip()]


def deterministic_id(kind: str, *parts: Any) -> str:
    material = "\x1f".join([kind, *(str(part) for part in parts)])
    return str(uuid.uuid5(MIGRATION_NAMESPACE, material))


def read_legacy_database(path: Path) -> LegacySnapshot:
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"legacy SQLite database not found: {resolved}")

    # URI read-only mode guarantees this process cannot mutate the source.
    connection = sqlite3.connect(f"{resolved.as_uri()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        existing = {
            row["name"]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        missing = REQUIRED_SOURCE_TABLES - existing
        if missing:
            raise RuntimeError(
                "legacy SQLite schema is incomplete; missing: "
                + ", ".join(sorted(missing))
            )

        def rows(query: str) -> list[dict[str, Any]]:
            return [dict(row) for row in connection.execute(query).fetchall()]

        return LegacySnapshot(
            papers=rows(
                "SELECT pmid, title, abstract, journal, pub_year, authors, "
                "collected_at FROM papers ORDER BY pmid"
            ),
            user_papers=rows(
                "SELECT user_id, pmid, collected_at FROM user_papers "
                "ORDER BY user_id, collected_at, pmid"
            ),
            keywords=rows(
                "SELECT user_id, pmid, keyword "
                "FROM user_paper_collection_keywords "
                "ORDER BY user_id, keyword, pmid"
            ),
            trends=rows(
                "SELECT user_id, keyword, year_from, year_to, papers_by_year, "
                "updated_at FROM user_collection_trend ORDER BY user_id"
            ),
            messages=rows(
                "SELECT id, user_id, conversation_id, role, content, created_at "
                "FROM chat_messages ORDER BY user_id, conversation_id, id"
            ),
        )
    finally:
        connection.close()


def _valid_year(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        year = int(value)
    except (TypeError, ValueError):
        return None
    return year if 1800 <= year <= 2200 else None


def _trend_counts(raw: Any) -> dict[str, int]:
    try:
        value = json.loads(str(raw or "{}"))
    except json.JSONDecodeError:
        return {}
    if not isinstance(value, dict):
        return {}
    result: dict[str, int] = {}
    for key, count in value.items():
        try:
            normalized = max(0, int(count))
        except (TypeError, ValueError):
            continue
        result[str(key)] = normalized
    return result


def build_plan(
    snapshot: LegacySnapshot,
    profile_map: Mapping[str, str],
) -> MigrationPlan:
    profiles = {
        normalize_user_key(key): str(value)
        for key, value in profile_map.items()
        if normalize_user_key(key)
    }
    plan = MigrationPlan()
    source_pmids: set[str] = set()
    paper_years: dict[str, int | None] = {}

    for row in snapshot.papers:
        pmid = str(row.get("pmid") or "").strip()
        title = str(row.get("title") or "").strip()
        if not pmid.isdigit() or not title:
            plan.skipped["invalid_papers"] = plan.skipped.get("invalid_papers", 0) + 1
            continue
        year = _valid_year(row.get("pub_year"))
        source_pmids.add(pmid)
        paper_years[pmid] = year
        plan.papers.append(
            Paper(
                pmid=pmid,
                title=title,
                abstract=str(row.get("abstract") or "").strip(),
                journal=str(row.get("journal") or "").strip(),
                publication_year=year,
                authors_json=json.dumps(
                    parse_authors(row.get("authors")), ensure_ascii=False
                ),
                collected_at=parse_legacy_timestamp(row.get("collected_at")),
            )
        )

    user_papers: dict[tuple[str, str], datetime] = {}
    for row in snapshot.user_papers:
        legacy_key = normalize_user_key(row.get("user_id"))
        pmid = str(row.get("pmid") or "").strip()
        if legacy_key not in profiles:
            if legacy_key:
                plan.missing_profile_keys.add(legacy_key)
            plan.skipped["collections_missing_profile"] = (
                plan.skipped.get("collections_missing_profile", 0) + 1
            )
            continue
        if pmid not in source_pmids:
            plan.skipped["collections_missing_paper"] = (
                plan.skipped.get("collections_missing_paper", 0) + 1
            )
            continue
        user_papers[(legacy_key, pmid)] = parse_legacy_timestamp(
            row.get("collected_at")
        )

    keyword_pmids: dict[tuple[str, str], set[str]] = {}
    paper_keywords: dict[tuple[str, str], list[str]] = {}
    for row in snapshot.keywords:
        legacy_key = normalize_user_key(row.get("user_id"))
        pmid = str(row.get("pmid") or "").strip()
        keyword = str(row.get("keyword") or "").strip()
        if not keyword:
            plan.skipped["blank_keywords"] = plan.skipped.get("blank_keywords", 0) + 1
            continue
        if (legacy_key, pmid) not in user_papers:
            if legacy_key and legacy_key not in profiles:
                plan.missing_profile_keys.add(legacy_key)
            plan.skipped["keyword_links_without_collection"] = (
                plan.skipped.get("keyword_links_without_collection", 0) + 1
            )
            continue
        keyword_pmids.setdefault((legacy_key, keyword), set()).add(pmid)
        paper_keywords.setdefault((legacy_key, pmid), []).append(keyword)

    trends: dict[tuple[str, str], dict[str, Any]] = {}
    for row in snapshot.trends:
        legacy_key = normalize_user_key(row.get("user_id"))
        keyword = str(row.get("keyword") or "").strip()
        if legacy_key not in profiles:
            if legacy_key:
                plan.missing_profile_keys.add(legacy_key)
            plan.skipped["trends_missing_profile"] = (
                plan.skipped.get("trends_missing_profile", 0) + 1
            )
            continue
        if not keyword:
            plan.skipped["blank_trends"] = plan.skipped.get("blank_trends", 0) + 1
            continue
        trends[(legacy_key, keyword)] = row
        keyword_pmids.setdefault((legacy_key, keyword), set())

    run_ids: dict[tuple[str, str], str] = {}
    for (legacy_key, keyword), pmids_set in sorted(keyword_pmids.items()):
        pmids = tuple(sorted(pmids_set, key=lambda value: int(value)))
        trend = trends.get((legacy_key, keyword))
        years = [paper_years[pmid] for pmid in pmids if paper_years[pmid] is not None]
        year_from = _valid_year(trend.get("year_from")) if trend else (min(years) if years else None)
        year_to = _valid_year(trend.get("year_to")) if trend else (max(years) if years else None)
        counts = _trend_counts(trend.get("papers_by_year")) if trend else {}
        result_count = sum(counts.values()) if counts else len(pmids)
        created_at = (
            parse_legacy_timestamp(trend.get("updated_at"))
            if trend
            else min(user_papers[(legacy_key, pmid)] for pmid in pmids)
        )
        run_id = deterministic_id("search-run", legacy_key, keyword)
        run_ids[(legacy_key, keyword)] = run_id
        plan.search_runs.append(
            SearchRun(
                id=run_id,
                user_id=profiles[legacy_key],
                legacy_user_key=legacy_key,
                query=keyword,
                year_from=year_from,
                year_to=year_to,
                max_results=min(10_000, max(1, result_count, len(pmids))),
                result_count=result_count,
                stored_count=len(pmids),
                request_params_json=json.dumps(
                    {
                        "legacy_import": True,
                        "papers_by_year": counts,
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                ),
                created_at=created_at,
                pmids=pmids,
            )
        )

    for (legacy_key, pmid), saved_at in sorted(user_papers.items()):
        keywords = sorted(paper_keywords.get((legacy_key, pmid), []))
        first_run_id = run_ids.get((legacy_key, keywords[0])) if keywords else None
        plan.collections.append(
            Collection(
                user_id=profiles[legacy_key],
                legacy_user_key=legacy_key,
                pmid=pmid,
                first_search_run_id=first_run_id,
                saved_at=saved_at,
            )
        )

    grouped_messages: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in snapshot.messages:
        legacy_key = normalize_user_key(row.get("user_id"))
        conversation_id = str(row.get("conversation_id") or "").strip()
        content = str(row.get("content") or "").strip()
        role = str(row.get("role") or "").strip()
        if legacy_key not in profiles:
            if legacy_key:
                plan.missing_profile_keys.add(legacy_key)
            plan.skipped["messages_missing_profile"] = (
                plan.skipped.get("messages_missing_profile", 0) + 1
            )
            continue
        if not conversation_id or not content or role not in {"user", "assistant"}:
            plan.skipped["invalid_messages"] = plan.skipped.get("invalid_messages", 0) + 1
            continue
        grouped_messages.setdefault((legacy_key, conversation_id), []).append(row)

    for (legacy_key, conversation_id), messages in sorted(grouped_messages.items()):
        room_id = deterministic_id("chat-room", legacy_key, conversation_id)
        timestamps = [parse_legacy_timestamp(row.get("created_at")) for row in messages]
        title_suffix = conversation_id if conversation_id != "default" else "기본 대화"
        plan.chat_rooms.append(
            ChatRoom(
                id=room_id,
                user_id=profiles[legacy_key],
                legacy_user_key=legacy_key,
                conversation_id=conversation_id,
                title=f"이전 대화 · {title_suffix}",
                created_at=min(timestamps),
                last_message_at=max(timestamps),
            )
        )
        for row, created_at in zip(messages, timestamps):
            legacy_id = row.get("id")
            plan.chat_messages.append(
                ChatMessage(
                    room_id=room_id,
                    user_id=profiles[legacy_key],
                    client_message_id=deterministic_id(
                        "chat-message",
                        legacy_key,
                        conversation_id,
                        legacy_id,
                    ),
                    role=str(row["role"]),
                    content=str(row["content"]).strip(),
                    created_at=created_at,
                )
            )

    return plan


class PostgresTarget:
    def __init__(self, database_url: str):
        self.connection = self._connect(database_url)

    @staticmethod
    def _connect(database_url: str):
        try:
            import psycopg  # type: ignore

            return psycopg.connect(database_url)
        except ImportError:
            try:
                import psycopg2  # type: ignore

                return psycopg2.connect(database_url)
            except ImportError as error:
                raise RuntimeError(
                    "PostgreSQL driver missing; install 'psycopg[binary]>=3.1' "
                    "or 'psycopg2-binary>=2.9'"
                ) from error

    def close(self) -> None:
        self.connection.close()

    def validate_schema(self) -> None:
        with self.connection.cursor() as cursor:
            cursor.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_name = ANY(%s)",
                (list(REQUIRED_TARGET_TABLES),),
            )
            existing = {row[0] for row in cursor.fetchall()}
        missing = REQUIRED_TARGET_TABLES - existing
        if missing:
            raise RuntimeError(
                "target schema is incomplete; apply supabase/schema.sql first. "
                "Missing: " + ", ".join(sorted(missing))
            )

    def load_profile_map(self) -> dict[str, str]:
        with self.connection.cursor() as cursor:
            cursor.execute(
                "SELECT legacy_user_key, id::text FROM public.user_profiles "
                "WHERE legacy_user_key IS NOT NULL"
            )
            return {
                normalize_user_key(legacy_key): user_id
                for legacy_key, user_id in cursor.fetchall()
            }

    def apply(self, plan: MigrationPlan) -> None:
        try:
            with self.connection.cursor() as cursor:
                self._upsert_papers(cursor, plan.papers)
                self._insert_search_runs(cursor, plan.search_runs)
                self._insert_collections(cursor, plan.collections)
                self._insert_chat(cursor, plan.chat_rooms, plan.chat_messages)
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

    @staticmethod
    def _executemany(cursor: Any, sql: str, values: Iterable[tuple[Any, ...]]) -> None:
        rows = list(values)
        if rows:
            cursor.executemany(sql, rows)

    def _upsert_papers(self, cursor: Any, papers: list[Paper]) -> None:
        self._executemany(
            cursor,
            """
            INSERT INTO public.pubmed_records (
              pmid, title, abstract, authors, journal, publication_year,
              pubmed_url, metadata_fetched_at, abstract_fetched_at, created_at
            )
            VALUES (%s, %s, %s, %s::jsonb, %s, %s, %s, %s,
                    CASE WHEN %s <> '' THEN %s ELSE NULL END, %s)
            ON CONFLICT (pmid) DO UPDATE SET
              title = CASE
                WHEN btrim(pubmed_records.title) = '' THEN EXCLUDED.title
                ELSE pubmed_records.title END,
              abstract = CASE
                WHEN btrim(pubmed_records.abstract) = ''
                 AND btrim(EXCLUDED.abstract) <> '' THEN EXCLUDED.abstract
                ELSE pubmed_records.abstract END,
              authors = CASE
                WHEN jsonb_array_length(pubmed_records.authors) = 0
                 AND jsonb_array_length(EXCLUDED.authors) > 0 THEN EXCLUDED.authors
                ELSE pubmed_records.authors END,
              journal = CASE
                WHEN btrim(pubmed_records.journal) = '' THEN EXCLUDED.journal
                ELSE pubmed_records.journal END,
              publication_year = COALESCE(
                pubmed_records.publication_year, EXCLUDED.publication_year),
              abstract_fetched_at = CASE
                WHEN btrim(pubmed_records.abstract) = ''
                 AND btrim(EXCLUDED.abstract) <> '' THEN EXCLUDED.abstract_fetched_at
                ELSE pubmed_records.abstract_fetched_at END
            """,
            (
                (
                    paper.pmid,
                    paper.title,
                    paper.abstract,
                    paper.authors_json,
                    paper.journal,
                    paper.publication_year,
                    f"https://pubmed.ncbi.nlm.nih.gov/{paper.pmid}/",
                    paper.collected_at,
                    paper.abstract,
                    paper.collected_at,
                    paper.collected_at,
                )
                for paper in papers
            ),
        )

    def _insert_search_runs(self, cursor: Any, runs: list[SearchRun]) -> None:
        self._executemany(
            cursor,
            """
            INSERT INTO public.search_runs (
              id, user_id, query, year_from, year_to, max_results, status,
              result_count, stored_count, request_params, started_at,
              completed_at, created_at
            )
            VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s, 'completed',
                    %s, %s, %s::jsonb, %s, %s, %s)
            ON CONFLICT (id) DO NOTHING
            """,
            (
                (
                    run.id,
                    run.user_id,
                    run.query,
                    run.year_from,
                    run.year_to,
                    run.max_results,
                    run.result_count,
                    run.stored_count,
                    run.request_params_json,
                    run.created_at,
                    run.created_at,
                    run.created_at,
                )
                for run in runs
            ),
        )
        self._executemany(
            cursor,
            """
            INSERT INTO public.search_run_papers (
              search_run_id, user_id, pmid, result_rank,
              added_to_collection, created_at
            )
            VALUES (%s::uuid, %s::uuid, %s, %s, true, %s)
            ON CONFLICT DO NOTHING
            """,
            (
                (run.id, run.user_id, pmid, rank, run.created_at)
                for run in runs
                for rank, pmid in enumerate(run.pmids, start=1)
            ),
        )

    def _insert_collections(
        self, cursor: Any, collections: list[Collection]
    ) -> None:
        self._executemany(
            cursor,
            """
            INSERT INTO public.user_paper_collections (
              user_id, pmid, first_search_run_id, saved_at
            )
            VALUES (%s::uuid, %s, %s::uuid, %s)
            ON CONFLICT (user_id, pmid) DO NOTHING
            """,
            (
                (
                    item.user_id,
                    item.pmid,
                    item.first_search_run_id,
                    item.saved_at,
                )
                for item in collections
            ),
        )

    def _insert_chat(
        self,
        cursor: Any,
        rooms: list[ChatRoom],
        messages: list[ChatMessage],
    ) -> None:
        self._executemany(
            cursor,
            """
            INSERT INTO public.chat_rooms (
              id, user_id, title, status, created_at, updated_at, last_message_at
            )
            VALUES (%s::uuid, %s::uuid, %s, 'active', %s, %s, %s)
            ON CONFLICT (id) DO NOTHING
            """,
            (
                (
                    room.id,
                    room.user_id,
                    room.title,
                    room.created_at,
                    room.last_message_at,
                    room.last_message_at,
                )
                for room in rooms
            ),
        )
        self._executemany(
            cursor,
            """
            INSERT INTO public.chat_messages (
              chat_room_id, user_id, role, content, client_message_id, created_at
            )
            VALUES (%s::uuid, %s::uuid, %s, %s, %s::uuid, %s)
            ON CONFLICT (chat_room_id, client_message_id) DO NOTHING
            """,
            (
                (
                    message.room_id,
                    message.user_id,
                    message.role,
                    message.content,
                    message.client_message_id,
                    message.created_at,
                )
                for message in messages
            ),
        )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Migrate legacy Publium SQLite data to Supabase PostgreSQL."
    )
    parser.add_argument(
        "--sqlite",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "pubmed.db",
        help="legacy SQLite path (default: repository pubmed.db)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="write changes; without this flag the command is a read-only dry-run",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        print("error: DATABASE_URL is required", file=sys.stderr)
        return 2
    if not database_url.lower().startswith(("postgresql://", "postgres://")):
        print("error: DATABASE_URL must be a PostgreSQL URL", file=sys.stderr)
        return 2

    target: PostgresTarget | None = None
    try:
        snapshot = read_legacy_database(args.sqlite)
        target = PostgresTarget(database_url)
        target.validate_schema()
        plan = build_plan(snapshot, target.load_profile_map())
        if args.apply:
            target.apply(plan)
        print(json.dumps(plan.report("apply" if args.apply else "dry-run"), indent=2))
        if plan.missing_profile_keys:
            print(
                "warning: rows owned by users without user_profiles.legacy_user_key "
                "were skipped",
                file=sys.stderr,
            )
        return 0
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    finally:
        if target is not None:
            target.close()


if __name__ == "__main__":
    raise SystemExit(main())
