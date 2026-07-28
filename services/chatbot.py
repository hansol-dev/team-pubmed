"""PubMed-grounded LangChain chat service."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator

from langchain.agents import create_agent
from langchain.tools import tool
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from langchain_openai import ChatOpenAI

from core import db
from services.chat_store import append_message, get_messages


def _build_paper_search_tool(user_id: str):
    # AIDEV-NOTE: The signed-session user ID is captured here and never exposed as a tool argument.
    @tool
    async def search_my_collected_papers(query: str = "", limit: int = 5) -> dict:
        """Search this user's collected PubMed papers.

        Use an empty query to list recent papers. Otherwise search by PMID,
        title, abstract, or the keyword used when collecting the paper.
        """
        safe_limit = max(1, min(int(limit), 10))
        papers = await asyncio.to_thread(
            db.search_papers,
            user_id,
            keyword=query.strip(),
            limit=safe_limit,
        )
        return {
            "count": len(papers),
            "papers": [
                {
                    "pmid": paper.get("pmid", ""),
                    "title": paper.get("title", ""),
                    "journal": paper.get("journal", ""),
                    "pub_year": paper.get("pub_year"),
                    "authors": paper.get("authors", ""),
                    "abstract": (paper.get("abstract") or "초록 내용 없음")[:2000],
                }
                for paper in papers
            ],
        }

    return search_my_collected_papers


async def stream_answer(
    question: str,
    conversation_id: str,
    user_id: str,
) -> AsyncIterator[str]:
    """Use a LangChain agent to retrieve user papers and stream its answer."""
    history = await asyncio.to_thread(
        get_messages,
        user_id,
        conversation_id,
        limit=40,
    )
    await asyncio.to_thread(
        append_message,
        user_id,
        conversation_id,
        "user",
        question,
    )

    if not os.getenv("OPENAI_API_KEY"):
        response = "OPENAI_API_KEY가 설정되지 않았습니다. 환경 변수를 설정한 뒤 다시 시도해 주세요."
        await asyncio.to_thread(
            append_message,
            user_id,
            conversation_id,
            "assistant",
            response,
        )
        yield response
        return

    system_prompt = (
        "당신은 PubMed 논문 탐색 도우미입니다. 사용자의 수집 논문이나 논문 근거가 필요한 "
        "질문에는 반드시 search_my_collected_papers 도구를 먼저 사용하세요. 이전 대화에서 "
        "언급한 논문을 묻는 후속 질문이면 대화 기록의 PMID나 핵심 키워드로 다시 검색하세요. "
        "도구가 반환한 논문 정보만 근거로 한국어로 답하고, 찾지 못했다면 없다고 명확히 "
        "말하세요. 의료 진단·처방은 제공하지 마세요. 논문을 근거로 답한 경우 마지막에 "
        "사용한 PMID를 나열하세요."
    )
    history_messages = [
        HumanMessage(content=message["content"])
        if message["role"] == "user"
        else AIMessage(content=message["content"])
        for message in history
    ]
    model = ChatOpenAI(model="gpt-4o-mini", temperature=0.2, streaming=True)
    agent = create_agent(
        model=model,
        tools=[_build_paper_search_tool(user_id)],
        system_prompt=system_prompt,
        name="pubmed_research_assistant",
    )
    answer_parts: list[str] = []
    try:
        async for chunk, _metadata in agent.astream(
            {
                "messages": [
                    *history_messages,
                    HumanMessage(content=question),
                ]
            },
            stream_mode="messages",
        ):
            if isinstance(chunk, AIMessageChunk) and chunk.text:
                token = str(chunk.text)
                answer_parts.append(token)
                yield token
    finally:
        if answer_parts:
            await asyncio.to_thread(
                append_message,
                user_id,
                conversation_id,
                "assistant",
                "".join(answer_parts),
            )
