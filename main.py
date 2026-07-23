"""FastAPI entry point for the PubMed paper analysis app.

The UI can be developed independently of A's ``core`` modules. Once those
modules are merged, the small adapter functions below become the integration
boundary between the web layer and the data layer.
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi import Request
from pydantic import BaseModel, Field
from starlette.middleware.sessions import SessionMiddleware

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

from auth import router as auth_router
from services.chatbot import stream_answer
from services.guard import blocked_response, is_medical_advice_request

app = FastAPI(title="PubMed Insight", version="0.1.0")
app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv("SESSION_SECRET", "local-development-secret-change-me"),
    https_only=False,
    same_site="lax",
)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")
app.include_router(auth_router)


class CollectRequest(BaseModel):
    keyword: str = Field(min_length=1, max_length=120)
    year_from: int | None = Field(default=None, ge=1900, le=2100)
    year_to: int | None = Field(default=None, ge=1900, le=2100)
    max_count: int = Field(default=50, ge=1, le=100)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2_000)
    conversation_id: str | None = Field(default=None, max_length=100)


@app.get("/")
async def index(request: Request):
    return templates.TemplateResponse(request, "index.html", {"user": request.session.get("user")})


def _core_modules():
    """Import A's modules only when an API is requested.

    Delayed import allows B's UI branch to run before the backend branch is
    merged, while keeping the eventual integration explicit.
    """
    try:
        from core import analysis, db, pubmed  # type: ignore

        return analysis, db, pubmed
    except ImportError as error:
        raise HTTPException(
            status_code=503,
            detail="데이터 모듈을 통합하는 중입니다. 잠시 후 다시 시도해 주세요.",
        ) from error


@app.post("/api/collect")
async def collect_papers(payload: CollectRequest):
    if payload.year_from and payload.year_to and payload.year_from > payload.year_to:
        raise HTTPException(status_code=400, detail="시작 연도는 종료 연도보다 클 수 없습니다.")

    _analysis, db, pubmed = _core_modules()
    try:
        papers = pubmed.collect(
            payload.keyword, payload.year_from, payload.year_to, payload.max_count
        )
        new_count, skipped_count = db.upsert_papers(papers)
        return {
            "new_count": new_count,
            "skipped_count": skipped_count,
            "total_count": db.count_papers(),
        }
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=502, detail="PubMed 수집에 실패했습니다.") from error


@app.get("/api/stats")
async def get_stats():
    analysis, db, _pubmed = _core_modules()
    try:
        papers = db.search_papers(limit=100)
        return {
            "total_papers": db.count_papers(),
            "total_journals": db.count_journals(),
            "papers_by_year": analysis.papers_by_year(papers),
            "top_journals": analysis.top_journals(papers),
        }
    except Exception as error:
        raise HTTPException(status_code=500, detail="통계를 불러오지 못했습니다.") from error


@app.get("/api/papers")
async def get_papers(
    keyword: str = "",
    year_from: int | None = None,
    year_to: int | None = None,
    journal: str = "",
):
    if year_from and year_to and year_from > year_to:
        raise HTTPException(status_code=400, detail="시작 연도는 종료 연도보다 클 수 없습니다.")
    _analysis, db, _pubmed = _core_modules()
    try:
        papers = db.search_papers(keyword, year_from, year_to, journal, limit=100)
        return {"papers": papers, "total": len(papers)}
    except Exception as error:
        raise HTTPException(status_code=500, detail="논문 목록을 불러오지 못했습니다.") from error


@app.post("/api/chat/stream")
async def chat_stream(payload: ChatRequest):
    if is_medical_advice_request(payload.message):
        async def blocked_events() -> AsyncIterator[str]:
            yield f"data: {json.dumps({'token': blocked_response()}, ensure_ascii=False)}\n\n"
            yield "event: done\ndata: {}\n\n"

        return StreamingResponse(blocked_events(), media_type="text/event-stream")

    _analysis, db, _pubmed = _core_modules()
    papers = db.search_papers(keyword=payload.message, limit=5)

    async def events() -> AsyncIterator[str]:
        async for chunk in stream_answer(payload.message, papers):
            yield f"data: {json.dumps({'token': chunk}, ensure_ascii=False)}\n\n"
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream")
