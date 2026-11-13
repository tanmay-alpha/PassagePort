"""POST /api/ask."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from passageport.answer.service import run_ask
from passageport.api.deps import Conn, CurrentUser, SettingsDep
from passageport.api.ratelimit import rate_limit
from passageport.api.schemas import AskIn, AskOut

router = APIRouter(prefix="/api", tags=["retrieval"], dependencies=[Depends(rate_limit)])


@router.post("/ask", response_model=AskOut)
def ask(body: AskIn, conn: Conn, user: CurrentUser, settings: SettingsDep) -> AskOut:
    """Answer a question from the collection's passages, or say that the evidence is insufficient."""
    return run_ask(conn, user, body, settings)
