"""POST /api/compare."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from passageport.api.deps import Conn, CurrentUser, SettingsDep
from passageport.api.ratelimit import rate_limit
from passageport.api.schemas import CompareIn, CompareOut
from passageport.compare.service import run_compare

router = APIRouter(prefix="/api", tags=["retrieval"], dependencies=[Depends(rate_limit)])


@router.post("/compare", response_model=CompareOut)
def compare(body: CompareIn, conn: Conn, user: CurrentUser, settings: SettingsDep) -> CompareOut:
    """Align what two to four documents say about a question and diff the aligned passages."""
    return run_compare(conn, user, body, settings)
