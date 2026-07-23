"""PubMed-grounded LangChain chat service."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

from langchain_openai import ChatOpenAI


def _paper_context(papers: list[dict]) -> str:
    if not papers:
        return "관련 논문을 찾지 못했습니다. 일반적인 연구 탐색 방향만 안내하세요."
    return "\n\n".join(
        f"PMID: {paper.get('pmid', '')}\n제목: {paper.get('title', '')}\n"
        f"저널: {paper.get('journal', '')} ({paper.get('pub_year', '')})\n"
        f"초록: {paper.get('abstract', '')[:1200]}"
        for paper in papers
    )


async def stream_answer(question: str, papers: list[dict]) -> AsyncIterator[str]:
    """Yield answer tokens grounded only in the retrieved paper metadata."""
    if not os.getenv("OPENAI_API_KEY"):
        yield "OPENAI_API_KEY가 설정되지 않았습니다. 환경 변수를 설정한 뒤 다시 시도해 주세요."
        return

    prompt = (
        "당신은 PubMed 논문 탐색 도우미입니다. 제공된 논문 정보만 근거로 한국어로 답하세요. "
        "의료 진단·처방은 제공하지 마세요. 근거가 부족하면 부족하다고 말하고, "
        "답변 마지막에 사용한 PMID를 나열하세요.\n\n"
        f"[논문 정보]\n{_paper_context(papers)}\n\n[사용자 질문]\n{question}"
    )
    model = ChatOpenAI(model="gpt-4o-mini", temperature=0.2, streaming=True)
    async for chunk in model.astream(prompt):
        if chunk.content:
            yield str(chunk.content)
