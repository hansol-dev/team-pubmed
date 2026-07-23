import json
import os
import tempfile
import unittest
from base64 import b64encode
from pathlib import Path
from unittest.mock import AsyncMock, patch

from authlib.integrations.base_client.errors import OAuthError
from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner

from auth import oauth
from main import app
from services import chat_store


def _session_cookie(email: str = "user@example.com") -> str:
    session = {
        "user": {
            "name": "테스트 사용자",
            "email": email,
            "picture": "",
        }
    }
    encoded = b64encode(json.dumps(session).encode("utf-8"))
    secret = os.getenv("SESSION_SECRET", "local-development-secret-change-me")
    return TimestampSigner(secret).sign(encoded).decode("utf-8")


class AuthenticationGateTests(unittest.TestCase):
    def test_health_check_is_public_and_lightweight(self):
        with TestClient(app) as client:
            response = client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})

    def test_unauthenticated_user_sees_landing_and_cannot_access_api(self):
        with TestClient(app) as client:
            page = client.get("/")
            api = client.get("/api/stats")

        self.assertEqual(page.status_code, 200)
        self.assertNotIn('id="collect-form"', page.text)
        self.assertEqual(api.status_code, 401)
        self.assertEqual(api.json()["detail"], "Google 로그인이 필요합니다.")

    def test_authenticated_user_sees_the_application(self):
        with TestClient(app) as client:
            client.cookies.set("session", _session_cookie())
            page = client.get("/")

        self.assertEqual(page.status_code, 200)
        self.assertIn('id="collect-form"', page.text)
        self.assertIn('id="clear-chat"', page.text)
        self.assertIn("테스트 사용자", page.text)

    def test_logout_clears_session_and_returns_landing(self):
        token = {
            "userinfo": {
                "name": "Google 사용자",
                "email": "user@example.com",
            }
        }
        with patch.object(
            oauth.google,
            "authorize_access_token",
            AsyncMock(return_value=token),
        ):
            with TestClient(app, follow_redirects=False) as client:
                client.get("/auth/callback")
                response = client.post("/auth/logout")
                page = client.get("/")

        self.assertEqual(response.status_code, 303)
        self.assertIn("session=null", response.headers["set-cookie"])
        self.assertEqual(page.status_code, 200)
        self.assertNotIn('id="collect-form"', page.text)

    def test_oauth_callback_returns_actionable_error(self):
        with patch.object(
            oauth.google,
            "authorize_access_token",
            AsyncMock(side_effect=OAuthError("mismatching_state", "CSRF Warning")),
        ):
            with TestClient(app) as client:
                response = client.get("/auth/callback")

        self.assertEqual(response.status_code, 400)
        self.assertIn("CSRF Warning", response.json()["detail"])

    def test_successful_oauth_callback_creates_login_session(self):
        token = {
            "userinfo": {
                "name": "Google 사용자",
                "email": "USER@EXAMPLE.COM",
                "picture": "https://example.com/profile.png",
            }
        }
        with patch.object(
            oauth.google,
            "authorize_access_token",
            AsyncMock(return_value=token),
        ):
            with TestClient(app, follow_redirects=False) as client:
                callback = client.get("/auth/callback")
                page = client.get("/")

        self.assertEqual(callback.status_code, 303)
        self.assertEqual(callback.headers["location"], "/")
        self.assertEqual(page.status_code, 200)
        self.assertIn("Google 사용자", page.text)


class PersistentChatIntegrationTests(unittest.TestCase):
    def test_chat_history_survives_a_new_client_and_is_user_scoped(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            test_db = Path(temp_dir) / "chat.db"
            with (
                patch.object(chat_store, "DATABASE_URL", ""),
                patch.object(chat_store, "DB_PATH", test_db),
            ):
                with TestClient(app) as first_client:
                    first_client.cookies.set("session", _session_cookie())
                    response = first_client.post(
                        "/api/chat/stream",
                        json={
                            "message": "이 증상을 진단해 주세요.",
                            "conversation_id": "default",
                        },
                    )
                    self.assertEqual(response.status_code, 200)
                    self.assertIn("답변할 수 없습니다", response.text)

                with TestClient(app) as restarted_client:
                    restarted_client.cookies.set("session", _session_cookie())
                    history = restarted_client.get("/api/chat/history").json()

                    restarted_client.cookies.set(
                        "session", _session_cookie("other@example.com")
                    )
                    other_history = restarted_client.get("/api/chat/history").json()

        self.assertEqual(
            [message["role"] for message in history["messages"]],
            ["user", "assistant"],
        )
        self.assertEqual(history["messages"][0]["content"], "이 증상을 진단해 주세요.")
        self.assertEqual(other_history["messages"], [])

    def test_delete_chat_history_is_authenticated_and_user_scoped(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            test_db = Path(temp_dir) / "chat.db"
            with (
                patch.object(chat_store, "DATABASE_URL", ""),
                patch.object(chat_store, "DB_PATH", test_db),
            ):
                chat_store.append_message(
                    "user@example.com", "default", "user", "삭제 대상"
                )
                chat_store.append_message(
                    "other@example.com", "default", "user", "유지 대상"
                )

                with TestClient(app) as client:
                    unauthenticated = client.delete("/api/chat/history")
                    client.cookies.set("session", _session_cookie())
                    deleted = client.delete("/api/chat/history")
                    history = client.get("/api/chat/history").json()

                other_messages = chat_store.get_messages(
                    "other@example.com", "default"
                )

        self.assertEqual(unauthenticated.status_code, 401)
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.json()["removed_count"], 1)
        self.assertEqual(history["messages"], [])
        self.assertEqual(other_messages[0]["content"], "유지 대상")


if __name__ == "__main__":
    unittest.main()
