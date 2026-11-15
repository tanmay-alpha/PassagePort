"""Request/response schemas. This module is the API contract shared by backend and frontend.

All routes live under ``/api``. Errors are ``{"error": {"code": str, "message": str}}``.
Timestamps are ISO-8601 UTC. IDs are opaque strings.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

DocumentStatus = Literal["uploaded", "processing", "indexed", "failed"]
DocumentKind = Literal["pdf", "txt", "md", "docx"]
LocatorKind = Literal["page", "section"]  # pdf -> page; txt/md/docx -> section
SearchMode = Literal["hybrid", "keyword", "semantic"]


class Schema(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --------------------------------------------------------------------------- errors


class ErrorBody(Schema):
    code: str
    message: str


class ErrorResponse(Schema):
    error: ErrorBody


# --------------------------------------------------------------------------- session / auth


class UserOut(Schema):
    id: str
    username: str
    is_guest: bool


class SessionOut(Schema):
    """GET /api/session — always 200, also when signed out."""

    auth_mode: Literal["local", "accounts"]
    authenticated: bool
    user: UserOut | None
    signup_enabled: bool
    signup_requires_code: bool
    guests_enabled: bool


class CredentialsIn(Schema):
    """POST /api/auth/login, POST /api/auth/signup (signup_code only for signup)."""

    username: str = Field(min_length=3, max_length=32, pattern=r"^[a-zA-Z0-9_.-]+$")
    password: str = Field(min_length=10, max_length=200)
    signup_code: str | None = Field(default=None, max_length=200)


class ApiTokenIn(Schema):
    name: str = Field(min_length=1, max_length=100)


class ApiTokenOut(Schema):
    id: str
    name: str
    created_at: datetime
    token: str | None = None  # only present in the creation response


# --------------------------------------------------------------------------- system


class ModelInfo(Schema):
    backend: str
    model: str
    dimensions: int | None = None
    loaded: bool
    enabled: bool = True


class LimitsOut(Schema):
    max_upload_bytes: int
    allowed_extensions: list[str]
    max_documents: int
    max_storage_bytes: int
    max_query_chars: int


class SearchDefaults(Schema):
    mode: SearchMode
    top_k: int
    candidates: int
    rrf_k: int
    lexical_weight: float
    vector_weight: float
    rerank: bool
    rerank_candidates: int
    bm25_k1: float
    bm25_b: float
    chunk_max_tokens: int


class UsageOut(Schema):
    collections: int
    documents: int
    chunks: int
    storage_bytes: int


class SystemOut(Schema):
    """GET /api/system — status page data. Never contains secrets."""

    version: str
    auth_mode: Literal["local", "accounts"]
    database: Literal["sqlite", "postgresql"]
    blob_backend: Literal["fs", "db"]
    embedding: ModelInfo
    reranker: ModelInfo
    llm_configured: bool
    llm_model: str | None
    limits: LimitsOut
    search_defaults: SearchDefaults
    usage: UsageOut
    pending_jobs: int


# --------------------------------------------------------------------------- collections


class CollectionIn(Schema):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)


class CollectionPatch(Schema):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)


class CollectionOut(Schema):
    id: str
    name: str
    description: str
    created_at: datetime
    updated_at: datetime
    document_count: int
    indexed_count: int
    processing_count: int  # uploaded + processing
    failed_count: int
    chunk_count: int
    size_bytes: int


# --------------------------------------------------------------------------- documents


class DocumentOut(Schema):
    id: str
    collection_id: str
    title: str
    filename: str
    kind: DocumentKind
    locator_kind: LocatorKind
    size_bytes: int
    sha256: str
    status: DocumentStatus
    # Human-readable reason for the last failed indexing attempt. May be set while status is
    # "indexed" when a re-index failed and the previous index was kept.
    error: str | None
    page_count: int
    chunk_count: int
    # True when the stored index was built with a different embedding model / chunker than the
    # server currently uses; such documents are excluded from semantic search until re-indexed.
    stale: bool
    created_at: datetime
    updated_at: datetime
    indexed_at: datetime | None


class DocumentPatch(Schema):
    title: str = Field(min_length=1, max_length=255)


class UploadOut(Schema):
    """POST /api/collections/{id}/documents (multipart field ``file``; one file per request).

    201 for a new document, 200 with ``duplicate=true`` when the same bytes already exist in the
    collection (the existing document is returned, nothing is stored twice).
    """

    document: DocumentOut
    duplicate: bool


class PageOut(Schema):
    """GET /api/documents/{id}/pages/{page_number} — extracted text of one page/section."""

    document_id: str
    page_number: int
    page_label: str
    page_count: int
    text: str


class OutlineItem(Schema):
    page_number: int
    page_label: str


class OutlineOut(Schema):
    """GET /api/documents/{id}/outline — labels of every page/section, for navigation."""

    document_id: str
    locator_kind: LocatorKind
    items: list[OutlineItem]


# --------------------------------------------------------------------------- passages / hits


class StageScore(Schema):
    rank: int  # 1-based rank within that retriever
    score: float


class HitScores(Schema):
    keyword: StageScore | None = None  # BM25
    semantic: StageScore | None = None  # cosine similarity
    fused: float | None = None  # weighted reciprocal-rank fusion score
    rerank: float | None = None  # cross-encoder logit


class Passage(Schema):
    """A citation target. ``char_start``/``char_end`` index into the text of the page."""

    chunk_id: str
    document_id: str
    document_title: str
    document_kind: DocumentKind
    locator_kind: LocatorKind
    page_number: int
    page_label: str
    char_start: int
    char_end: int
    text: str


class Hit(Passage):
    rank: int  # 1-based position in this result list
    scores: HitScores
    matched_terms: list[str] = []  # query terms found by the keyword retriever


class ChunkOut(Passage):
    """GET /api/chunks/{chunk_id} — resolve a citation."""


# --------------------------------------------------------------------------- search

# A document filter names documents of one collection; the bound keeps the ownership query within
# database parameter limits (an unbounded list produced a 500 from the SQL driver).
MAX_DOCUMENT_FILTER = 1000


class SearchIn(Schema):
    query: str = Field(min_length=1)
    collection_id: str
    # Restrict the search to these documents.
    document_ids: list[str] | None = Field(default=None, max_length=MAX_DOCUMENT_FILTER)
    mode: SearchMode = "hybrid"
    rerank: bool | None = None  # None -> server default
    top_k: int = Field(default=8, ge=1, le=50)


class EffectiveSettings(Schema):
    """Everything needed to reproduce a ranking."""

    mode: SearchMode
    top_k: int
    candidates: int
    rrf_k: int
    lexical_weight: float
    vector_weight: float
    reranked: bool
    rerank_candidates: int
    bm25_k1: float
    bm25_b: float
    embedding_version: str
    reranker: str | None
    index_version: int


class SearchOut(Schema):
    query: str
    results: list[Hit]
    # True when nothing cleared the relevance thresholds; results (if any) are best-effort.
    low_confidence: bool
    notice: str | None  # user-facing explanation for empty / low-confidence / partial results
    settings: EffectiveSettings
    timings_ms: dict[
        str, float
    ]  # e.g. {"embed":..,"keyword":..,"semantic":..,"fuse":..,"rerank":..,"total":..}


# --------------------------------------------------------------------------- ask


class AskIn(Schema):
    question: str = Field(min_length=1)
    collection_id: str
    document_ids: list[str] | None = Field(default=None, max_length=MAX_DOCUMENT_FILTER)
    top_k: int = Field(default=6, ge=1, le=12)


class Evidence(Hit):
    ref: int  # the [n] used in answer citations, 1-based


class AnswerSegment(Schema):
    text: str
    citations: list[int]  # Evidence.ref values; always valid refs
    # generated: True if the segment cites at least one passage. extractive: always True.
    supported: bool


class AskOut(Schema):
    question: str
    # generated: written by the configured LLM from the evidence.
    # extractive: no LLM; verbatim sentences selected from the evidence.
    # insufficient: evidence too weak to answer; ``segments`` is empty.
    mode: Literal["generated", "extractive", "insufficient"]
    segments: list[AnswerSegment]
    evidence: list[Evidence]
    notice: str | None
    llm_model: str | None
    # What was actually checked. Never claims factual verification.
    checks: list[str]
    timings_ms: dict[str, float]


# --------------------------------------------------------------------------- compare


class CompareIn(Schema):
    question: str = Field(min_length=1)
    document_ids: list[str] = Field(min_length=2, max_length=4)
    top_k_per_document: int = Field(default=4, ge=1, le=8)
    interpret: bool = True  # ask the LLM for an interpretation when one is configured


class CompareDocument(Schema):
    document_id: str
    title: str
    has_evidence: bool  # False -> "no relevant passage found", shown explicitly
    evidence: list[Evidence]  # refs are unique across the whole response


class AlignedPassage(Schema):
    document_id: str
    ref: int


class NumericDifference(Schema):
    context: str  # the shared words around the number
    values: dict[str, str]  # document_id -> value as written


class Alignment(Schema):
    """Passages from different documents that discuss the same thing (embedding similarity)."""

    passages: list[AlignedPassage]  # one per document that has a counterpart
    similarity: float
    # Computed from the text itself — not model output:
    shared_sentences: list[str]  # sentences that appear (near-)verbatim in every aligned passage
    unique_sentences: dict[str, list[str]]  # document_id -> sentences with no close counterpart
    numeric_differences: list[NumericDifference]
    identical: bool


class CompareOut(Schema):
    question: str
    documents: list[CompareDocument]
    alignments: list[Alignment]
    unaligned: list[AlignedPassage]  # evidence with no counterpart in another document
    # LLM-written, clearly labelled as interpretation; None when no LLM / interpret=false.
    interpretation: list[AnswerSegment] | None
    llm_model: str | None
    notice: str | None
    timings_ms: dict[str, float]


# --------------------------------------------------------------------------- search lab


class LabIn(Schema):
    query: str = Field(min_length=1)
    collection_id: str
    document_ids: list[str] | None = Field(default=None, max_length=MAX_DOCUMENT_FILTER)
    top_k: int = Field(default=10, ge=1, le=30)
    candidates: int | None = Field(default=None, ge=1, le=200)
    rrf_k: int | None = Field(default=None, ge=1, le=1000)
    lexical_weight: float | None = Field(default=None, ge=0, le=10)
    vector_weight: float | None = Field(default=None, ge=0, le=10)
    rerank: bool = True


class LabStage(Schema):
    results: list[Hit]
    ms: float


class IndexInfo(Schema):
    chunks: int
    documents: int
    vocabulary: int
    average_chunk_tokens: float
    index_version: int
    build_ms: float  # time spent building the in-memory index for this version
    cached: bool
    vector_search: str  # e.g. "exact cosine (brute force)"
    tokenizer: str


class LabOut(Schema):
    query: str
    query_terms: list[str]  # after keyword tokenization
    keyword: LabStage
    semantic: LabStage
    fused: LabStage
    reranked: LabStage | None  # None when no reranker is available / requested
    embed_ms: float
    total_ms: float
    settings: EffectiveSettings
    index: IndexInfo
    embedding: ModelInfo
    reranker: ModelInfo


class EvalRun(Schema):
    name: str  # e.g. "keyword", "semantic", "hybrid", "hybrid+rerank"
    recall_at_k: dict[str, float]
    precision_at_k: dict[str, float]
    mrr: float
    ndcg_at_10: float | None = None
    latency_ms_p50: float
    latency_ms_p95: float


class EvalDataset(Schema):
    name: str
    description: str
    documents: int
    chunks: int
    queries: int
    embedding_version: str
    reranker: str | None
    indexing_chunks_per_second: float
    runs: list[EvalRun]


class EvalReport(Schema):
    """GET /api/lab/evaluation — the last committed, reproducible evaluation run (404 if none)."""

    generated_at: datetime
    git_commit: str | None
    hardware: str
    command: str
    datasets: list[EvalDataset]
