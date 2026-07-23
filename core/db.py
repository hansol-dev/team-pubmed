"""SQLite/PostgreSQL persistence and querying for PubMed records."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from core.database import adapt_query, connect, uses_postgres

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
DB_PATH = Path(os.getenv("PUBMED_DB_PATH", Path(__file__).resolve().parents[1] / "pubmed.db"))

_SQLITE_SCHEMA = """
CREATE TABLE IF NOT EXISTS papers (
    pmid TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    abstract TEXT NOT NULL DEFAULT '',
    journal TEXT NOT NULL DEFAULT '',
    pub_year INTEGER,
    authors TEXT NOT NULL DEFAULT '',
    collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""

_POSTGRES_SCHEMA = """
CREATE TABLE IF NOT EXISTS papers (
    pmid TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    abstract TEXT NOT NULL DEFAULT '',
    journal TEXT NOT NULL DEFAULT '',
    pub_year INTEGER,
    authors TEXT NOT NULL DEFAULT '',
    collected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""

_SQLITE_USER_PAPERS_SCHEMA = """
CREATE TABLE IF NOT EXISTS user_papers (
    user_id TEXT NOT NULL COLLATE NOCASE,
    pmid TEXT NOT NULL,
    collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, pmid),
    FOREIGN KEY (pmid) REFERENCES papers(pmid) ON DELETE CASCADE
)
"""

_POSTGRES_USER_PAPERS_SCHEMA = """
CREATE TABLE IF NOT EXISTS user_papers (
    user_id TEXT NOT NULL,
    pmid TEXT NOT NULL,
    collected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, pmid),
    FOREIGN KEY (pmid) REFERENCES papers(pmid) ON DELETE CASCADE
)
"""

_SQLITE_USER_TREND_SCHEMA = """
CREATE TABLE IF NOT EXISTS user_collection_trend (
    user_id TEXT PRIMARY KEY COLLATE NOCASE,
    keyword TEXT NOT NULL,
    year_from INTEGER NOT NULL,
    year_to INTEGER NOT NULL,
    papers_by_year TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""

_POSTGRES_USER_TREND_SCHEMA = """
CREATE TABLE IF NOT EXISTS user_collection_trend (
    user_id TEXT PRIMARY KEY,
    keyword TEXT NOT NULL,
    year_from INTEGER NOT NULL,
    year_to INTEGER NOT NULL,
    papers_by_year TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""

_SQLITE_USER_KEYWORD_SCHEMA = """
CREATE TABLE IF NOT EXISTS user_paper_collection_keywords (
    user_id TEXT NOT NULL COLLATE NOCASE,
    pmid TEXT NOT NULL,
    keyword TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (user_id, pmid, keyword),
    FOREIGN KEY (user_id, pmid) REFERENCES user_papers(user_id, pmid) ON DELETE CASCADE
)
"""

_POSTGRES_USER_KEYWORD_SCHEMA = """
CREATE TABLE IF NOT EXISTS user_paper_collection_keywords (
    user_id TEXT NOT NULL,
    pmid TEXT NOT NULL,
    keyword TEXT NOT NULL,
    PRIMARY KEY (user_id, pmid, keyword),
    FOREIGN KEY (user_id, pmid) REFERENCES user_papers(user_id, pmid) ON DELETE CASCADE
)
"""


def _connect():
    return connect(DATABASE_URL, DB_PATH)


def _query(query: str) -> str:
    return adapt_query(query, DATABASE_URL)


def init_db() -> None:
    """Create shared paper metadata and user-scoped collection tables."""
    with _connect() as connection:
        connection.execute(
            _POSTGRES_SCHEMA if uses_postgres(DATABASE_URL) else _SQLITE_SCHEMA
        )
        connection.execute(
            _POSTGRES_USER_PAPERS_SCHEMA
            if uses_postgres(DATABASE_URL)
            else _SQLITE_USER_PAPERS_SCHEMA
        )
        connection.execute(
            _POSTGRES_USER_TREND_SCHEMA
            if uses_postgres(DATABASE_URL)
            else _SQLITE_USER_TREND_SCHEMA
        )
        connection.execute(
            _POSTGRES_USER_KEYWORD_SCHEMA
            if uses_postgres(DATABASE_URL)
            else _SQLITE_USER_KEYWORD_SCHEMA
        )
        # AIDEV-NOTE: Existing global papers stay unassigned; each user starts empty.
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_papers_year ON papers(pub_year)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_papers_journal ON papers(journal)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_user_collection_keywords "
            "ON user_paper_collection_keywords(user_id, keyword)"
        )


def upsert_papers(
    user_id: str,
    papers: list[dict],
    collection_keyword: str = "",
) -> tuple[int, int]:
    """Store metadata and add unseen PMIDs to one user's collection."""
    user_id = _normalize_user_id(user_id)
    init_db()
    inserted = 0
    collection_keyword = collection_keyword.strip()
    with _connect() as connection:
        for paper in papers:
            normalized = _normalize_paper(paper)
            connection.execute(
                _query(
                    """
                INSERT INTO papers
                    (pmid, title, abstract, journal, pub_year, authors)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (pmid) DO NOTHING
                """,
                ),
                (
                    normalized["pmid"],
                    normalized["title"],
                    normalized["abstract"],
                    normalized["journal"],
                    normalized["pub_year"],
                    normalized["authors"],
                ),
            )
            user_cursor = connection.execute(
                _query(
                    """
                INSERT INTO user_papers (user_id, pmid)
                VALUES (?, ?)
                ON CONFLICT (user_id, pmid) DO NOTHING
                """,
                ),
                (user_id, normalized["pmid"]),
            )
            inserted += user_cursor.rowcount
            if collection_keyword:
                # AIDEV-NOTE: Keep every PMID-to-query association; one paper may be collected by multiple searches.
                connection.execute(
                    _query(
                        """
                    INSERT INTO user_paper_collection_keywords (user_id, pmid, keyword)
                    VALUES (?, ?, ?)
                    ON CONFLICT (user_id, pmid, keyword) DO NOTHING
                    """,
                    ),
                    (user_id, normalized["pmid"], collection_keyword),
                )
    return inserted, len(papers) - inserted


def search_papers(
    user_id: str,
    keyword: str = "",
    year_from: int | None = None,
    year_to: int | None = None,
    journal: str = "",
    limit: int = 100,
) -> list[dict]:
    """Return papers matching title, abstract, collection keyword, year, and journal."""
    user_id = _normalize_user_id(user_id)
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise ValueError("limit must be a positive integer")
    if year_from is not None and year_to is not None and year_from > year_to:
        raise ValueError("year_from must be less than or equal to year_to")

    init_db()
    conditions = ["owned.user_id = ?"]
    params: list[Any] = [user_id]
    keyword = keyword.strip()
    journal = journal.strip()

    if keyword:
        insensitive_like = "ILIKE" if uses_postgres(DATABASE_URL) else "LIKE"
        no_case = "" if uses_postgres(DATABASE_URL) else " COLLATE NOCASE"
        conditions.append(
            "("
            f"p.title {insensitive_like} ?{no_case} OR "
            f"p.abstract {insensitive_like} ?{no_case} OR "
            "EXISTS ("
            "SELECT 1 FROM user_paper_collection_keywords AS collected "
            "WHERE collected.user_id = owned.user_id "
            "AND collected.pmid = p.pmid "
            f"AND collected.keyword {insensitive_like} ?{no_case}"
            ")"
            ")"
        )
        pattern = f"%{keyword}%"
        params.extend((pattern, pattern, pattern))
    if year_from is not None:
        conditions.append("p.pub_year >= ?")
        params.append(year_from)
    if year_to is not None:
        conditions.append("p.pub_year <= ?")
        params.append(year_to)
    if journal:
        if uses_postgres(DATABASE_URL):
            conditions.append("p.journal ILIKE ?")
        else:
            conditions.append("p.journal = ? COLLATE NOCASE")
        params.append(journal)

    where = f" WHERE {' AND '.join(conditions)}"
    params.append(limit)
    query = (
        "SELECT p.pmid, p.title, p.abstract, p.journal, p.pub_year, p.authors "
        "FROM papers AS p "
        "INNER JOIN user_papers AS owned ON owned.pmid = p.pmid "
        f"{where} "
        "ORDER BY p.pub_year DESC, CAST(p.pmid AS BIGINT) DESC LIMIT ?"
    )
    with _connect() as connection:
        return [
            dict(row)
            for row in connection.execute(_query(query), params).fetchall()
        ]


def count_papers(user_id: str) -> int:
    user_id = _normalize_user_id(user_id)
    init_db()
    with _connect() as connection:
        row = connection.execute(
            _query("SELECT COUNT(*) AS count FROM user_papers WHERE user_id = ?"),
            (user_id,),
        ).fetchone()
        return int(row["count"])


def count_journals(user_id: str) -> int:
    user_id = _normalize_user_id(user_id)
    init_db()
    with _connect() as connection:
        return int(
            connection.execute(
                _query(
                    "SELECT COUNT(DISTINCT p.journal) AS count "
                    "FROM papers AS p "
                    "INNER JOIN user_papers AS owned ON owned.pmid = p.pmid "
                    "WHERE owned.user_id = ? AND p.journal <> ''"
                ),
                (user_id,),
            ).fetchone()["count"]
        )


def clear_papers(user_id: str) -> int:
    """Clear one user's collection and return the number of removed associations."""
    user_id = _normalize_user_id(user_id)
    init_db()
    with _connect() as connection:
        connection.execute(
            _query("DELETE FROM user_paper_collection_keywords WHERE user_id = ?"),
            (user_id,),
        )
        removed = connection.execute(
            _query("DELETE FROM user_papers WHERE user_id = ?"),
            (user_id,),
        ).rowcount
        connection.execute(
            _query("DELETE FROM user_collection_trend WHERE user_id = ?"),
            (user_id,),
        )
        connection.execute(
            "DELETE FROM papers WHERE NOT EXISTS "
            "(SELECT 1 FROM user_papers WHERE user_papers.pmid = papers.pmid)"
        )
    return int(removed)


def save_collection_trend(
    user_id: str,
    keyword: str,
    year_from: int,
    year_to: int,
    papers_by_year: dict[int, int],
) -> None:
    """Persist one user's latest PubMed annual-search trend."""
    user_id = _normalize_user_id(user_id)
    init_db()
    with _connect() as connection:
        connection.execute(
            _query(
                """
            INSERT INTO user_collection_trend
                (user_id, keyword, year_from, year_to, papers_by_year)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                keyword = excluded.keyword,
                year_from = excluded.year_from,
                year_to = excluded.year_to,
                papers_by_year = excluded.papers_by_year,
                updated_at = CURRENT_TIMESTAMP
            """,
            ),
            (user_id, keyword, year_from, year_to, json.dumps(papers_by_year)),
        )


def get_collection_trend(user_id: str) -> dict | None:
    """Return one user's latest persisted annual PubMed trend."""
    user_id = _normalize_user_id(user_id)
    init_db()
    with _connect() as connection:
        row = connection.execute(
            _query(
                "SELECT keyword, year_from, year_to, papers_by_year "
                "FROM user_collection_trend WHERE user_id = ?"
            ),
            (user_id,),
        ).fetchone()
    if row is None:
        return None
    return {
        "keyword": row["keyword"],
        "year_from": row["year_from"],
        "year_to": row["year_to"],
        "papers_by_year": json.loads(row["papers_by_year"]),
    }


def _normalize_paper(paper: dict) -> dict[str, Any]:
    pmid = str(paper.get("pmid") or "").strip()
    if not pmid:
        raise ValueError("each paper must have a non-empty pmid")

    pub_year = paper.get("pub_year")
    if pub_year in (None, ""):
        pub_year = None
    elif isinstance(pub_year, bool):
        raise ValueError("pub_year must be an integer or None")
    else:
        try:
            pub_year = int(pub_year)
        except (TypeError, ValueError) as error:
            raise ValueError("pub_year must be an integer or None") from error

    return {
        "pmid": pmid,
        "title": str(paper.get("title") or "").strip(),
        "abstract": str(paper.get("abstract") or "").strip(),
        "journal": str(paper.get("journal") or "").strip(),
        "pub_year": pub_year,
        "authors": str(paper.get("authors") or "").strip(),
    }


def _normalize_user_id(user_id: str) -> str:
    normalized = str(user_id or "").strip().casefold()
    if not normalized:
        raise ValueError("user_id must not be empty")
    return normalized
