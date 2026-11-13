"""Search Lab: the retrieval pipeline with every stage, timing and setting exposed.

The lab runs the same ``retrieve`` as Search in hybrid mode, with optional per-request overrides,
and shows the top ``top_k`` of each stage. Every hit carries its rank and score in both retrievers,
so the fused score of any row can be recomputed by hand from the response.
"""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import ValidationError
from sqlalchemy import Connection

from passageport.api.schemas import EvalReport, IndexInfo, LabIn, LabOut, LabStage, ModelInfo
from passageport.config import Settings
from passageport.domain import User
from passageport.errors import not_found
from passageport.ml import registry
from passageport.search.index import VECTOR_SEARCH
from passageport.search.service import RetrievalParams, retrieve
from passageport.search.tokenize import TOKENIZER_NAME

BUNDLED_REPORT = Path(__file__).resolve().parent.parent / "evaluation" / "report.json"


def run_lab(conn: Connection, user: User, body: LabIn, settings: Settings) -> LabOut:
    params = RetrievalParams.from_settings(
        settings,
        mode="hybrid",
        top_k=body.top_k,
        candidates=body.candidates,
        rrf_k=body.rrf_k,
        lexical_weight=body.lexical_weight,
        vector_weight=body.vector_weight,
        rerank=body.rerank,
    )
    result = retrieve(
        conn,
        user,
        query=body.query,
        collection_id=body.collection_id,
        document_ids=body.document_ids,
        params=params,
        settings=settings,
    )
    timings = result.timings
    stats = result.index.stats
    reranker = registry.get_reranker()
    return LabOut(
        query=result.query,
        query_terms=result.query_terms,
        keyword=LabStage(results=result.hits(result.keyword, body.top_k), ms=timings["keyword"]),
        semantic=LabStage(results=result.hits(result.semantic, body.top_k), ms=timings["semantic"]),
        fused=LabStage(results=result.hits(result.fused, body.top_k), ms=timings["fuse"]),
        reranked=(
            LabStage(results=result.hits(result.reranked, body.top_k), ms=timings["rerank"])
            if result.reranked is not None
            else None
        ),
        embed_ms=timings["embed"],
        total_ms=timings["total"],
        settings=result.effective_settings(),
        index=IndexInfo(
            chunks=stats.chunks,
            documents=stats.documents,
            vocabulary=stats.vocabulary,
            average_chunk_tokens=round(stats.average_chunk_tokens, 1),
            index_version=result.index.index_version,
            build_ms=round(stats.build_ms, 3),
            cached=result.cached,
            vector_search=VECTOR_SEARCH,
            tokenizer=TOKENIZER_NAME,
        ),
        embedding=ModelInfo(
            backend=result.embedder.backend,
            model=result.embedder.model,
            dimensions=result.embedder.dimensions,
            loaded=True,
        ),
        reranker=ModelInfo(
            backend=reranker.backend if reranker else "none",
            model=reranker.model if reranker else "",
            loaded=registry.models_loaded()["reranker"],
            enabled=reranker is not None,
        ),
    )


def load_eval_report(settings: Settings) -> EvalReport:
    """The committed evaluation report; 404 when none is available or it does not match the schema."""
    path = settings.eval_report_path or BUNDLED_REPORT
    try:
        return EvalReport.model_validate(json.loads(Path(path).read_text(encoding="utf-8")))
    except (OSError, ValueError, ValidationError):
        raise not_found("Evaluation report") from None
