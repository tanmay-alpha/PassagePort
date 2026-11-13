"""POST /api/search."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from passageport.api.deps import Conn, CurrentUser, SettingsDep
from passageport.api.ratelimit import rate_limit
from passageport.api.schemas import SearchIn, SearchOut
from passageport.search.service import run_search

router = APIRouter(prefix="/api", tags=["retrieval"], dependencies=[Depends(rate_limit)])


@router.post("/search", response_model=SearchOut)
def search(body: SearchIn, conn: Conn, user: CurrentUser, settings: SettingsDep) -> SearchOut:
    """Keyword, semantic or hybrid search in one collection, with page-accurate citations."""
    return run_search(conn, user, body, settings)
