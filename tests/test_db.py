import tempfile
import unittest
import sqlite3
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from core import db


class DatabaseTests(unittest.TestCase):
    USER = "user@example.com"

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_url_patch = patch.object(db, "DATABASE_URL", "")
        self.database_url_patch.start()
        self.db_patch = patch.object(db, "DB_PATH", Path(self.temp_dir.name) / "test.db")
        self.db_patch.start()

    def tearDown(self):
        self.db_patch.stop()
        self.database_url_patch.stop()
        self.temp_dir.cleanup()

    def test_upsert_skips_duplicate_pmids_and_counts_distinct_journals(self):
        papers = [
            self.paper("1", "COVID vaccine", "Journal A", 2023),
            self.paper("2", "Cancer study", "Journal B", 2024),
        ]
        self.assertEqual(db.upsert_papers(self.USER, papers), (2, 0))
        self.assertEqual(db.upsert_papers(self.USER, papers), (0, 2))
        self.assertEqual(db.count_papers(self.USER), 2)
        self.assertEqual(db.count_journals(self.USER), 2)

    def test_search_combines_all_filters(self):
        db.upsert_papers(
            self.USER,
            [
                self.paper("1", "COVID vaccine", "Journal A", 2023),
                self.paper("2", "COVID outcomes", "Journal B", 2024),
                self.paper("3", "Cancer study", "Journal A", 2024),
            ]
        )
        result = db.search_papers(
            self.USER,
            keyword="covid", year_from=2023, year_to=2023, journal="journal a"
        )
        self.assertEqual([paper["pmid"] for paper in result], ["1"])

    def test_search_includes_blank_abstract_paper_collected_by_keyword(self):
        paper = self.paper("1", "A title without the query term", "Journal A", 2023)
        paper["abstract"] = ""
        db.upsert_papers(self.USER, [paper], collection_keyword="diabetes")

        self.assertEqual(
            [
                result["pmid"]
                for result in db.search_papers(self.USER, keyword="diabetes")
            ],
            ["1"],
        )
        self.assertEqual(db.search_papers(self.USER, keyword="unrelated"), [])

    def test_duplicate_paper_keeps_every_collection_keyword(self):
        paper = self.paper("1", "Shared paper", "Journal A", 2023)
        db.upsert_papers(self.USER, [paper], collection_keyword="diabetes")
        self.assertEqual(
            db.upsert_papers(self.USER, [paper], collection_keyword="neuropathy"),
            (0, 1),
        )

        self.assertEqual(len(db.search_papers(self.USER, keyword="diabetes")), 1)
        self.assertEqual(len(db.search_papers(self.USER, keyword="neuropathy")), 1)

    def test_clear_papers_removes_all_collected_records(self):
        db.upsert_papers(
            self.USER,
            [
                self.paper("1", "COVID vaccine", "Journal A", 2023),
                self.paper("2", "Cancer study", "Journal B", 2024),
            ]
        )

        self.assertEqual(db.clear_papers(self.USER), 2)
        self.assertEqual(db.count_papers(self.USER), 0)
        self.assertEqual(db.clear_papers(self.USER), 0)

    def test_existing_global_records_are_not_assigned_to_a_user(self):
        with closing(sqlite3.connect(db.DB_PATH)) as connection:
            with connection:
                connection.execute(
                    """
                    CREATE TABLE papers (
                        pmid TEXT PRIMARY KEY, title TEXT NOT NULL,
                        abstract TEXT NOT NULL DEFAULT '', journal TEXT NOT NULL DEFAULT '',
                        pub_year INTEGER, authors TEXT NOT NULL DEFAULT '',
                        collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                connection.execute(
                    "INSERT INTO papers "
                    "(pmid, title, abstract, journal, pub_year, authors) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    ("9", "Legacy paper", "Abstract", "Legacy Journal", 2022, "Jane Doe"),
                )

        self.assertEqual(db.count_papers(self.USER), 0)
        self.assertEqual(db.search_papers(self.USER), [])

    def test_collection_trend_persists_and_is_cleared_with_papers(self):
        db.upsert_papers(
            self.USER, [self.paper("1", "COVID vaccine", "Journal A", 2023)]
        )
        db.save_collection_trend(
            self.USER, "covid", 2022, 2023, {2022: 11, 2023: 17}
        )

        self.assertEqual(
            db.get_collection_trend(self.USER),
            {
                "keyword": "covid",
                "year_from": 2022,
                "year_to": 2023,
                "papers_by_year": {"2022": 11, "2023": 17},
            },
        )

        db.clear_papers(self.USER)
        self.assertIsNone(db.get_collection_trend(self.USER))

    def test_papers_keywords_trends_and_reset_are_isolated_by_user(self):
        other_user = "other@example.com"
        shared_paper = self.paper("1", "Shared paper", "Journal A", 2023)
        own_paper = self.paper("2", "Only mine", "Journal B", 2024)

        db.upsert_papers(
            self.USER, [shared_paper, own_paper], collection_keyword="mine"
        )
        db.upsert_papers(other_user, [shared_paper], collection_keyword="theirs")
        db.save_collection_trend(
            self.USER, "mine", 2023, 2024, {2023: 1, 2024: 1}
        )
        db.save_collection_trend(
            other_user, "theirs", 2023, 2023, {2023: 1}
        )

        self.assertEqual(db.count_papers(self.USER), 2)
        self.assertEqual(db.count_papers(other_user), 1)
        self.assertEqual(len(db.search_papers(self.USER, keyword="mine")), 2)
        self.assertEqual(db.search_papers(other_user, keyword="mine"), [])
        self.assertEqual(db.get_collection_trend(other_user)["keyword"], "theirs")

        self.assertEqual(db.clear_papers(self.USER), 2)
        self.assertEqual(db.count_papers(self.USER), 0)
        self.assertEqual(db.count_papers(other_user), 1)
        self.assertEqual(db.search_papers(other_user)[0]["pmid"], "1")
        self.assertIsNone(db.get_collection_trend(self.USER))
        self.assertEqual(db.get_collection_trend(other_user)["keyword"], "theirs")

    def test_init_db_uses_documented_schema(self):
        db.init_db()
        with closing(sqlite3.connect(db.DB_PATH)) as connection:
            paper_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(papers)").fetchall()
            }
            user_paper_columns = {
                row[1]
                for row in connection.execute(
                    "PRAGMA table_info(user_papers)"
                ).fetchall()
            }
        self.assertEqual(
            paper_columns,
            {"pmid", "title", "abstract", "journal", "pub_year", "authors", "collected_at"},
        )
        self.assertEqual(user_paper_columns, {"user_id", "pmid", "collected_at"})

    @staticmethod
    def paper(pmid, title, journal, pub_year):
        return {
            "pmid": pmid,
            "title": title,
            "abstract": f"Abstract for {title}",
            "journal": journal,
            "pub_year": pub_year,
            "authors": "Jane Doe",
        }


if __name__ == "__main__":
    unittest.main()
