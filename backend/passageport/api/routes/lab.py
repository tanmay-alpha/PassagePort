"""POST /api/lab/search and GET /api/lab/evaluation."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from passageport.api.deps import Conn, CurrentUser, SettingsDep
from passageport.api.ratelimit import rate_limit
from passageport.api.schemas import EvalReport, LabIn, LabOut
from passageport.lab.service import load_eval_report, run_lab

router = APIRouter(prefix="/api/lab", tags=["search lab"], dependencies=[Depends(rate_limit)])


@router.post("/search", response_model=LabOut)
def lab_search(body: LabIn, conn: Conn, user: CurrentUser, settings: SettingsDep) -> LabOut:
    """Hybrid search with every stage, score, timing and effective setting exposed."""
    return run_lab(conn, user, body, settings)


@router.get("/evaluation", response_model=EvalReport)
def lab_evaluation(user: CurrentUser, settings: SettingsDep) -> EvalReport:  # noqa: ARG001 - auth only
    """The last committed evaluation run (404 when no report is bundled or configured)."""
    return load_eval_report(settings)
