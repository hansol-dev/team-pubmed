import asyncio
import threading
import unittest
from time import monotonic
from unittest.mock import patch

from main import CollectRequest, collect_papers, health


class _BlockingPubMed:
    def __init__(self, started: threading.Event, release: threading.Event):
        self.started = started
        self.release = release

    def collect(self, *_args):
        self.started.set()
        self.release.wait(timeout=2)
        return []


class _FakeDb:
    @staticmethod
    def upsert_papers(_papers, collection_keyword=""):
        return 0, 0

    @staticmethod
    def count_papers():
        return 0


class AsyncResponsivenessTests(unittest.IsolatedAsyncioTestCase):
    async def test_health_remains_responsive_during_blocking_pubmed_collection(self):
        started = threading.Event()
        release = threading.Event()
        fallback_release = threading.Timer(1, release.set)
        fallback_release.start()

        payload = CollectRequest(
            keyword="diabetes",
            year_from=2020,
            year_to=2025,
            max_count=10,
        )
        began_at = monotonic()
        try:
            with patch(
                "main._core_modules",
                return_value=(object(), _FakeDb(), _BlockingPubMed(started, release)),
            ):
                collection = asyncio.create_task(
                    collect_papers(payload, {"email": "user@example.com"})
                )
                self.assertTrue(
                    await asyncio.to_thread(started.wait, 0.5),
                    "PubMed collection did not start",
                )

                response = await asyncio.wait_for(health(), timeout=0.2)
                elapsed = monotonic() - began_at
                release.set()
                result = await asyncio.wait_for(collection, timeout=1)
        finally:
            release.set()
            fallback_release.cancel()

        self.assertEqual(response, {"status": "ok"})
        self.assertLess(elapsed, 0.5)
        self.assertEqual(result["total_count"], 0)


if __name__ == "__main__":
    unittest.main()
