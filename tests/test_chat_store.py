import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from services import chat_store


class ChatStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_url_patch = patch.object(chat_store, "DATABASE_URL", "")
        self.database_url_patch.start()
        self.db_patch = patch.object(
            chat_store,
            "DB_PATH",
            Path(self.temp_dir.name) / "chat.db",
        )
        self.db_patch.start()

    def tearDown(self):
        self.db_patch.stop()
        self.database_url_patch.stop()
        self.temp_dir.cleanup()

    def test_messages_persist_in_sqlite_and_remain_user_scoped(self):
        chat_store.append_message("USER@example.com", "default", "user", "첫 질문")
        chat_store.append_message("user@example.com", "default", "assistant", "첫 답변")
        chat_store.append_message("other@example.com", "default", "user", "다른 사용자")

        messages = chat_store.get_messages("user@example.com", "default")

        self.assertEqual(
            [(message["role"], message["content"]) for message in messages],
            [("user", "첫 질문"), ("assistant", "첫 답변")],
        )
        with closing(sqlite3.connect(chat_store.DB_PATH)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM chat_messages").fetchone()[0], 3)

    def test_limit_returns_latest_messages_in_conversation_order(self):
        for index in range(5):
            chat_store.append_message("user@example.com", "default", "user", str(index))

        messages = chat_store.get_messages("user@example.com", "default", limit=2)

        self.assertEqual([message["content"] for message in messages], ["3", "4"])

    def test_delete_messages_only_removes_the_target_user_and_conversation(self):
        chat_store.append_message("user@example.com", "default", "user", "삭제 대상")
        chat_store.append_message("user@example.com", "saved", "user", "다른 대화")
        chat_store.append_message("other@example.com", "default", "user", "다른 사용자")

        removed = chat_store.delete_messages("USER@example.com", "default")

        self.assertEqual(removed, 1)
        self.assertEqual(chat_store.get_messages("user@example.com", "default"), [])
        self.assertEqual(
            chat_store.get_messages("user@example.com", "saved")[0]["content"],
            "다른 대화",
        )
        self.assertEqual(
            chat_store.get_messages("other@example.com", "default")[0]["content"],
            "다른 사용자",
        )


if __name__ == "__main__":
    unittest.main()
