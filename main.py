"""FastAPI entry point for the PubMed paper analysis app.

The UI can be developed independently of A's ``core`` modules. Once those
modules are merged, the small adapter functions below become the integration
boundary between the web layer and the data layer.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import os
from collections.abc import AsyncIterator
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi import Request
from pydantic import BaseModel, Field
from starlette.middleware.sessions import SessionMiddleware

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

from auth import router as auth_router
from services.chat_store import append_message, get_messages
from services.guard import blocked_response, is_medical_advice_request

app = FastAPI(title="Publium", version="0.1.0")
app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv("SESSION_SECRET", "local-development-secret-change-me"),
    max_age=60 * 60 * 24 * 30,
    https_only=os.getenv("HTTPS_ONLY", "false").lower() == "true",
    same_site="lax",
)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")
app.include_router(auth_router)
# AIDEV-NOTE: Bound PubMed work on small single-worker deployments so long requests cannot exhaust the thread pool.
PUBMED_CONCURRENCY = asyncio.Semaphore(2)


class CollectRequest(BaseModel):
    keyword: str = Field(min_length=1, max_length=120)
    year_from: int = Field(ge=1900, le=2100)
    year_to: int = Field(ge=1900, le=2100)
    max_count: int = Field(default=50, ge=1, le=100)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2_000)
    conversation_id: str | None = Field(default=None, max_length=100)


@app.get("/health", include_in_schema=False)
async def health():
    return {"status": "ok"}


@app.get("/")
async def index(request: Request):
    user = request.session.get("user")
    if not user:
        return templates.TemplateResponse(request, "landing.html")
    return templates.TemplateResponse(request, "index.html", {"user": user})


@app.get("/landing/preview")
async def landing_preview(request: Request):
    """Read-only application shell embedded in the public landing page."""
    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "user": {"name": "Publium", "email": "preview@publium.local"},
            "preview": True,
        },
    )


def require_user(request: Request) -> dict[str, str]:
    user = request.session.get("user")
    if not user or not user.get("email"):
        raise HTTPException(status_code=401, detail="Google 로그인이 필요합니다.")
    return user


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
async def collect_papers(
    payload: CollectRequest,
    _user: dict[str, str] = Depends(require_user),
):
    if payload.year_from > payload.year_to:
        raise HTTPException(status_code=400, detail="시작 연도는 종료 연도보다 클 수 없습니다.")

    _analysis, db, pubmed = _core_modules()
    try:
        async with PUBMED_CONCURRENCY:
            papers = await asyncio.to_thread(
                pubmed.collect,
                payload.keyword,
                payload.year_from,
                payload.year_to,
                payload.max_count,
            )
        new_count, skipped_count = await asyncio.to_thread(
            db.upsert_papers,
            papers, collection_keyword=payload.keyword
        )
        return {
            "new_count": new_count,
            "skipped_count": skipped_count,
            "total_count": await asyncio.to_thread(db.count_papers),
        }
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=502, detail="PubMed 수집에 실패했습니다.") from error


@app.get("/api/stats")
async def get_stats(_user: dict[str, str] = Depends(require_user)):
    analysis, db, _pubmed = _core_modules()
    try:
        def build_stats() -> dict:
            total_papers = db.count_papers()
            # AIDEV-NOTE: Overview statistics cover the full DB; only the paper list is capped at 100 rows.
            papers = db.search_papers(limit=max(total_papers, 1))
            return {
                "total_papers": total_papers,
                "total_journals": db.count_journals(),
                "papers_by_year": analysis.papers_by_year(papers),
                "top_journals": analysis.top_journals(papers),
                "latest_trend": db.get_collection_trend(),
            }

        return await asyncio.to_thread(build_stats)
    except Exception as error:
        raise HTTPException(status_code=500, detail="통계를 불러오지 못했습니다.") from error


@app.get("/api/trend")
async def get_publication_trend(
    keyword: str,
    year_from: int = 1900,
    year_to: int = 2100,
    persist: bool = False,
    _user: dict[str, str] = Depends(require_user),
):
    """Return PubMed's full ESearch count for each year, not the 100-paper sample."""
    if not keyword.strip():
        raise HTTPException(status_code=400, detail="추세 분석을 위한 검색 키워드를 입력해 주세요.")
    if year_from > year_to:
        raise HTTPException(status_code=400, detail="시작 연도는 종료 연도보다 클 수 없습니다.")

    _analysis, db, pubmed = _core_modules()
    count_by_year = getattr(pubmed, "count_by_year", None)
    if count_by_year is None:
        raise HTTPException(
            status_code=503,
            detail="연도별 전체 건수 모듈을 통합하는 중입니다.",
        )
    try:
        async with PUBMED_CONCURRENCY:
            papers_by_year = await asyncio.to_thread(
                count_by_year,
                keyword.strip(),
                year_from,
                year_to,
            )
        if persist:
            await asyncio.to_thread(
                db.save_collection_trend,
                keyword.strip(),
                year_from,
                year_to,
                papers_by_year,
            )
        return {
            "keyword": keyword.strip(),
            "papers_by_year": papers_by_year,
        }
    except Exception as error:
        raise HTTPException(status_code=502, detail="연도별 PubMed 건수를 불러오지 못했습니다.") from error


@app.get("/api/papers")
async def get_papers(
    keyword: str = "",
    year_from: int | None = None,
    year_to: int | None = None,
    journal: str = "",
    _user: dict[str, str] = Depends(require_user),
):
    if year_from and year_to and year_from > year_to:
        raise HTTPException(status_code=400, detail="시작 연도는 종료 연도보다 클 수 없습니다.")
    _analysis, db, _pubmed = _core_modules()
    try:
        papers = await asyncio.to_thread(
            db.search_papers,
            keyword,
            year_from,
            year_to,
            journal,
            100,
        )
        return {"papers": papers, "total": len(papers)}
    except Exception as error:
        raise HTTPException(status_code=500, detail="논문 목록을 불러오지 못했습니다.") from error


@app.get("/api/metadata")
async def get_collected_metadata(_user: dict[str, str] = Depends(require_user)):
    """Return every paper stored in SQLite for the metadata library tab."""
    _analysis, db, _pubmed = _core_modules()
    try:
        def load_metadata() -> tuple[int, list[dict]]:
            total = db.count_papers()
            papers = db.search_papers(limit=max(total, 1))
            return total, papers

        total, papers = await asyncio.to_thread(load_metadata)
        return {"papers": papers, "total": total}
    except Exception as error:
        raise HTTPException(status_code=500, detail="수집된 메타데이터를 불러오지 못했습니다.") from error


@app.post("/api/papers/reset")
async def reset_collected_papers(_user: dict[str, str] = Depends(require_user)):
    """Remove only locally collected SQLite records after a UI confirmation."""
    _analysis, db, _pubmed = _core_modules()
    try:
        return {"removed_count": await asyncio.to_thread(db.clear_papers)}
    except Exception as error:
        raise HTTPException(status_code=500, detail="수집 데이터를 초기화하지 못했습니다.") from error


@app.post("/api/chat/stream")
async def chat_stream(
    payload: ChatRequest,
    user: dict[str, str] = Depends(require_user),
):
    conversation_id = payload.conversation_id or "default"
    user_id = user["email"]
    # AIDEV-NOTE: user_id always comes from the signed session, never from a client-supplied payload.
    if is_medical_advice_request(payload.message):
        response_text = blocked_response()

        def save_blocked_exchange() -> None:
            append_message(user_id, conversation_id, "user", payload.message)
            append_message(user_id, conversation_id, "assistant", response_text)

        await asyncio.to_thread(save_blocked_exchange)

        async def blocked_events() -> AsyncIterator[str]:
            yield f"data: {json.dumps({'token': response_text}, ensure_ascii=False)}\n\n"
            yield "event: done\ndata: {}\n\n"

        return StreamingResponse(blocked_events(), media_type="text/event-stream")

    _analysis, db, _pubmed = _core_modules()
    papers = await asyncio.to_thread(
        db.search_papers,
        keyword=payload.message,
        limit=5,
    )

    async def events() -> AsyncIterator[str]:
        # AIDEV-NOTE: Lazy import keeps LangChain/OpenAI out of the deployment health-check cold start.
        chatbot = await asyncio.to_thread(
            importlib.import_module,
            "services.chatbot",
        )

        async for chunk in chatbot.stream_answer(
            payload.message,
            papers,
            conversation_id,
            user_id,
        ):
            yield f"data: {json.dumps({'token': chunk}, ensure_ascii=False)}\n\n"
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream")


@app.get("/api/chat/history")
async def chat_history(
    conversation_id: str = "default",
    user: dict[str, str] = Depends(require_user),
):
    return {
        "conversation_id": conversation_id,
        "messages": await asyncio.to_thread(
            get_messages,
            user["email"],
            conversation_id,
            limit=200,
        ),
    }
