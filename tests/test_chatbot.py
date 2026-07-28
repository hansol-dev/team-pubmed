import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from langchain_core.messages import AIMessageChunk, ToolMessage

from services import chatbot


class _FakeAgent:
    def __init__(self):
        self.input = None
        self.stream_mode = None

    async def astream(self, input_data, stream_mode):
        self.input = input_data
        self.stream_mode = stream_mode
        yield ToolMessage(content="검색 완료", tool_call_id="call-1"), {}
        yield AIMessageChunk(content="논문 "), {}
        yield AIMessageChunk(content="답변"), {}


class ChatbotTests(unittest.IsolatedAsyncioTestCase):
    async def test_paper_search_tool_is_user_scoped_and_caps_results(self):
        paper = {
            "pmid": "123",
            "title": "Paper",
            "journal": "Journal",
            "pub_year": 2024,
            "authors": "Jane Doe",
            "abstract": "",
        }
        with patch.object(chatbot.db, "search_papers", return_value=[paper]) as search:
            paper_search = chatbot._build_paper_search_tool("user@example.com")
            result = await paper_search.ainvoke({"query": "123", "limit": 50})

        self.assertEqual(set(paper_search.args), {"query", "limit"})
        search.assert_called_once_with(
            "user@example.com",
            keyword="123",
            limit=10,
        )
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["papers"][0]["abstract"], "초록 내용 없음")

    async def test_agent_receives_history_and_streams_only_ai_answer(self):
        fake_agent = _FakeAgent()
        history = [
            {"role": "user", "content": "당뇨 논문을 찾아줘"},
            {"role": "assistant", "content": "PMID 123을 찾았습니다."},
        ]
        append = MagicMock()

        with (
            patch.dict("os.environ", {"OPENAI_API_KEY": "test-key"}),
            patch.object(chatbot, "get_messages", return_value=history),
            patch.object(chatbot, "append_message", append),
            patch.object(chatbot, "ChatOpenAI"),
            patch.object(chatbot, "create_agent", return_value=fake_agent) as create,
        ):
            chunks = [
                chunk
                async for chunk in chatbot.stream_answer(
                    "그 논문 초록을 알려줘",
                    "default",
                    "user@example.com",
                )
            ]

        self.assertEqual(chunks, ["논문 ", "답변"])
        self.assertEqual(fake_agent.stream_mode, "messages")
        self.assertEqual(
            [message.content for message in fake_agent.input["messages"]],
            [
                "당뇨 논문을 찾아줘",
                "PMID 123을 찾았습니다.",
                "그 논문 초록을 알려줘",
            ],
        )
        create.assert_called_once()
        append.assert_any_call(
            "user@example.com",
            "default",
            "assistant",
            "논문 답변",
        )

    async def test_missing_api_key_does_not_create_an_agent(self):
        append = MagicMock()
        with (
            patch.dict("os.environ", {}, clear=True),
            patch.object(chatbot, "get_messages", return_value=[]),
            patch.object(chatbot, "append_message", append),
            patch.object(chatbot, "create_agent", AsyncMock()) as create,
        ):
            chunks = [
                chunk
                async for chunk in chatbot.stream_answer(
                    "논문을 찾아줘",
                    "default",
                    "user@example.com",
                )
            ]

        self.assertEqual(len(chunks), 1)
        self.assertIn("OPENAI_API_KEY", chunks[0])
        create.assert_not_called()


if __name__ == "__main__":
    unittest.main()
