"""Health check and the status page data."""

from __future__ import annotations

from fastapi import APIRouter

from passageport import __version__
from passageport.api.deps import Conn, CurrentUser, SettingsDep
from passageport.api.schemas import LimitsOut, ModelInfo, SearchDefaults, SystemOut, UsageOut
from passageport.config import ALLOWED_EXTENSIONS, Settings
from passageport.db import repos
from passageport.ml.registry import get_embedder, models_loaded

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health")
def health() -> dict[str, str]:
    """Liveness only: no authentication and nothing about the deployment."""
    return {"status": "ok"}


def embedding_info(settings: Settings) -> ModelInfo:
    """Describe the embedding model without forcing it to load.

    Dimensions are only known once a real model is in memory; the hashing backend is free to
    construct, so it is always reported in full.
    """
    loaded = models_loaded()["embedder"]
    if loaded or settings.embedding_backend == "hashing":
        embedder = get_embedder()
        return ModelInfo(
            backend=embedder.backend, model=embedder.model, dimensions=embedder.dimensions, loaded=True
        )
    return ModelInfo(backend=settings.embedding_backend, model=settings.embedding_model, loaded=False)


def reranker_info(settings: Settings) -> ModelInfo:
    enabled = settings.reranker_backend != "none"
    return ModelInfo(
        backend=settings.reranker_backend,
        model=settings.reranker_model if enabled else "",
        loaded=models_loaded()["reranker"],
        enabled=enabled,
    )


@router.get("/system", response_model=SystemOut)
def system(conn: Conn, user: CurrentUser, settings: SettingsDep) -> SystemOut:
    """Configuration and usage for the status page. Usage and pending jobs are the caller's own.
    Deliberately omits secrets, filesystem paths, the database URL and the LLM endpoint."""
    usage = repos.user_usage(conn, user.id)
    return SystemOut(
        version=__version__,
        auth_mode=settings.auth_mode,
        database="sqlite" if settings.resolved_database_url.startswith("sqlite") else "postgresql",
        blob_backend=settings.blob_backend,
        embedding=embedding_info(settings),
        reranker=reranker_info(settings),
        llm_configured=settings.llm_configured,
        llm_model=settings.llm_model if settings.llm_configured else None,
        limits=LimitsOut(
            max_upload_bytes=settings.max_upload_bytes,
            allowed_extensions=list(ALLOWED_EXTENSIONS),
            max_documents=settings.max_documents_per_user,
            max_storage_bytes=settings.max_storage_mb_per_user * 1024 * 1024,
            max_query_chars=settings.max_query_chars,
        ),
        search_defaults=SearchDefaults(
            mode="hybrid",
            top_k=settings.search_top_k,
            candidates=settings.search_candidates,
            rrf_k=settings.rrf_k,
            lexical_weight=settings.lexical_weight,
            vector_weight=settings.vector_weight,
            rerank=settings.rerank_by_default and settings.reranker_backend != "none",
            rerank_candidates=settings.rerank_candidates,
            bm25_k1=settings.bm25_k1,
            bm25_b=settings.bm25_b,
            chunk_max_tokens=settings.chunk_max_tokens,
        ),
        usage=UsageOut(
            collections=usage.collections,
            documents=usage.documents,
            chunks=usage.chunks,
            storage_bytes=usage.storage_bytes,
        ),
        pending_jobs=repos.pending_job_count(conn, user.id),
    )
