from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "migrate_sqlite_to_supabase.py"
SPEC = importlib.util.spec_from_file_location("legacy_migration", SCRIPT)
assert SPEC and SPEC.loader
migration = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = migration
SPEC.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "legacy.db"
        connection = sqlite3.connect(self.db_path)
        connection.executescript(
            """
            CREATE TABLE papers (
              pmid TEXT PRIMARY KEY, title TEXT NOT NULL,
              abstract TEXT NOT NULL DEFAULT '', journal TEXT NOT NULL DEFAULT '',
              pub_year INTEGER, authors TEXT NOT NULL DEFAULT '',
              collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE user_papers (
              user_id TEXT NOT NULL, pmid TEXT NOT NULL,
              collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (user_id, pmid)
            );
            CREATE TABLE user_paper_collection_keywords (
              user_id TEXT NOT NULL, pmid TEXT NOT NULL, keyword TEXT NOT NULL,
              PRIMARY KEY (user_id, pmid, keyword)
            );
            CREATE TABLE user_collection_trend (
              user_id TEXT PRIMARY KEY, keyword TEXT NOT NULL,
              year_from INTEGER NOT NULL, year_to INTEGER NOT NULL,
              papers_by_year TEXT NOT NULL,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE chat_messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
              conversation_id TEXT NOT NULL, role TEXT NOT NULL,
              content TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        connection.execute(
            "INSERT INTO papers VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                "123",
                "A useful paper",
                "Stored abstract",
                "Journal",
                2024,
                "Ada Lovelace, Grace Hopper",
                "2026-01-01 01:00:00",
            ),
        )
        for email in ("known@example.com", "missing@example.com"):
            connection.execute(
                "INSERT INTO user_papers VALUES (?, '123', ?)",
                (email, "2026-01-02 01:00:00"),
            )
            connection.execute(
                "INSERT INTO user_paper_collection_keywords VALUES (?, '123', ?)",
                (email, "fertility"),
            )
        connection.execute(
            "INSERT INTO user_collection_trend VALUES (?, ?, ?, ?, ?, ?)",
            (
                "known@example.com",
                "fertility",
                2020,
                2025,
                json.dumps({"2024": 7}),
                "2026-01-03 01:00:00",
            ),
        )
        connection.executemany(
            "INSERT INTO chat_messages "
            "(user_id, conversation_id, role, content, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            [
                (
                    "known@example.com",
                    "default",
                    "user",
                    "Summarize it",
                    "2026-01-04 01:00:00",
                ),
                (
                    "known@example.com",
                    "default",
                    "assistant",
                    "Summary",
                    "2026-01-04 01:00:01",
                ),
                (
                    "missing@example.com",
                    "default",
                    "user",
                    "Skipped",
                    "2026-01-04 01:00:02",
                ),
            ],
        )
        connection.commit()
        connection.close()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_read_and_build_plan_preserves_abstract_and_reports_missing_user(self):
        snapshot = migration.read_legacy_database(self.db_path)
        plan = migration.build_plan(
            snapshot,
            {"known@example.com": "11111111-1111-1111-1111-111111111111"},
        )

        self.assertEqual(plan.papers[0].abstract, "Stored abstract")
        self.assertEqual(
            json.loads(plan.papers[0].authors_json),
            ["Ada Lovelace", "Grace Hopper"],
        )
        self.assertEqual(len(plan.collections), 1)
        self.assertEqual(len(plan.search_runs), 1)
        self.assertEqual(plan.search_runs[0].result_count, 7)
        self.assertEqual(plan.search_runs[0].pmids, ("123",))
        self.assertEqual(len(plan.chat_rooms), 1)
        self.assertEqual(len(plan.chat_messages), 2)
        self.assertEqual(plan.missing_profile_keys, {"missing@example.com"})
        self.assertEqual(plan.skipped["collections_missing_profile"], 1)
        self.assertEqual(plan.skipped["messages_missing_profile"], 1)

    def test_generated_ids_are_stable_across_runs(self):
        snapshot = migration.read_legacy_database(self.db_path)
        profiles = {
            "known@example.com": "11111111-1111-1111-1111-111111111111"
        }
        first = migration.build_plan(snapshot, profiles)
        second = migration.build_plan(snapshot, profiles)

        self.assertEqual(first.search_runs[0].id, second.search_runs[0].id)
        self.assertEqual(first.chat_rooms[0].id, second.chat_rooms[0].id)
        self.assertEqual(
            [message.client_message_id for message in first.chat_messages],
            [message.client_message_id for message in second.chat_messages],
        )

    def test_source_database_is_opened_read_only(self):
        snapshot = migration.read_legacy_database(self.db_path)
        self.assertEqual(len(snapshot.papers), 1)
        connection = sqlite3.connect(self.db_path)
        count = connection.execute("SELECT count(*) FROM papers").fetchone()[0]
        connection.close()
        self.assertEqual(count, 1)

    def test_missing_required_table_is_rejected(self):
        incomplete = Path(self.temp_dir.name) / "incomplete.db"
        connection = sqlite3.connect(incomplete)
        connection.execute("CREATE TABLE papers (pmid TEXT)")
        connection.close()
        with self.assertRaisesRegex(RuntimeError, "schema is incomplete"):
            migration.read_legacy_database(incomplete)


if __name__ == "__main__":
    unittest.main()
