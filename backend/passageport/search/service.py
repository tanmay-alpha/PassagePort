"""Retrieval: the one code path behind Search, Ask, Compare and the Search Lab.

``retrieve`` runs every stage (keyword, semantic, fusion, optional cross-encoder re-ranking), keeps
each stage's ranking and timing, and judges whether the best evidence is strong enough to be
presented as relevant. Callers differ only in how they present the ``Retrieval``.

Relevance rules (thresholds are settings, calibrated in docs/SEARCH_EVALUATION.md)
----------------------------------------------------------------------------------
A ranking always returns the closest passages, even for a question the collection cannot answer.
The result is therefore marked ``low_confidence`` unless at least one returned passage shows
positive evidence of relevance:

1. Re-ranked: the best cross-encoder score is >= ``min_rerank_score``. The cross-encoder reads
   query and passage together and is the strongest signal available, so when it ran it decides.
2. Not re-ranked, semantic or hybrid: the best cosine similarity is >= ``min_vector_similarity``.
3. Not re-ranked, any mode: one passage contains every searchable term of the query (keyword
   coverage 1.0). This is what makes an exact identifier lookup confident without a model.

"Empty" situations get a plain-language notice instead of silently returning nothing: no documents,
nothing indexed yet, selected documents not searchable, or documents excluded because they were
embedded by a different model.
"""

from __future__ import annotations

import time
from collections.abc import Sequence
from dataclasses import dataclass, field, replace

import numpy as np
from sqlalchemy import Connection, func, select

from passageport.api.schemas import EffectiveSettings, Evidence, Hit, HitScores, SearchIn, SearchOut, StageScore
from passageport.config import Settings
from passageport.db.access import require_collection, require_documents
from passageport.db.schema import documents
from passageport.domain import IndexedChunk, User, locator_kind
from passageport.errors import ApiError
from passageport.ml import registry
from passageport.ml.protocols import Embedder, Reranker
from passageport.search import index as index_module
from passageport.search.fusion import weighted_rrf
from passageport.search.index import CollectionIndex
from passageport.search.tokenize import matched_surfaces, query_terms

NOTICE_NO_DOCUMENTS = "This collection has no documents yet. Upload a document to search it."
NOTICE_INDEXING = "The documents in this collection are still being indexed. Try again in a moment."
NOTICE_NOTHING_INDEXED = "No document in this collection has been indexed successfully, so there is nothing to search."
NOTICE_ALL_STALE = (
    "The documents in this collection were indexed with a different embedding model. "
    "Re-index them to make them searchable."
)
NOTICE_SELECTION_EMPTY = (
    "The selected documents have no searchable passages: they are still being indexed, failed, "
    "or need to be re-indexed."
)
NOTICE_NO_MATCH = "No passage matches this query."
NOTICE_LOW_CONFIDENCE = (
    "No passage clearly matches this query. The results shown are the closest text found and may not be relevant."
)

FULL_KEYWORD_COVERAGE = 0.999


def notice_stale(count: int) -> str:
    noun = "document was" if count == 1 else "documents were"
    return f"{count} {noun} indexed with a different embedding model and left out. Re-index to include them."


@dataclass(frozen=True, slots=True)
class RetrievalParams:
    mode: str
    top_k: int
    candidates: int
    rrf_k: int
    lexical_weight: float
    vector_weight: float
    rerank: bool
    rerank_candidates: int
    bm25_k1: float
    bm25_b: float
    min_vector_similarity: float
    min_rerank_score: float

    @classmethod
    def from_settings(cls, settings: Settings, **overrides: object) -> RetrievalParams:
        """Server defaults with per-request overrides; ``None`` means "use the default"."""
        params = cls(
            mode="hybrid",
            top_k=settings.search_top_k,
            candidates=settings.search_candidates,
            rrf_k=settings.rrf_k,
            lexical_weight=settings.lexical_weight,
            vector_weight=settings.vector_weight,
            rerank=settings.rerank_by_default,
            rerank_candidates=settings.rerank_candidates,
            bm25_k1=settings.bm25_k1,
            bm25_b=settings.bm25_b,
            min_vector_similarity=settings.min_vector_similarity,
            min_rerank_score=settings.min_rerank_score,
        )
        params = replace(params, **{k: v for k, v in overrides.items() if v is not None})
        if params.mode == "hybrid" and params.lexical_weight == 0 and params.vector_weight == 0:
            raise ApiError(422, "invalid_request", "lexical_weight and vector_weight cannot both be zero.")
        # A single retriever must be able to fill the page on its own.
        return replace(params, candidates=max(params.candidates, params.top_k))


@dataclass(slots=True)
class Candidate:
    """One chunk and what every stage said about it."""

    row: int
    keyword: StageScore | None = None
    semantic: StageScore | None = None
    fused: float | None = None
    rerank: float | None = None
    # Filled for the final results only; inputs of the relevance rules.
    similarity: float | None = None
    coverage: float = 0.0
    relevant: bool = False


@dataclass(frozen=True, slots=True)
class Confidence:
    best_similarity: float | None  # None when no query embedding was computed
    best_rerank: float | None  # None when not re-ranked
    keyword_coverage: float  # best idf-weighted share of query terms found in one returned passage
    confident: bool


@dataclass(slots=True)
class Retrieval:
    query: str
    params: RetrievalParams
    index: CollectionIndex
    cached: bool
    embedder: Embedder
    reranker_name: str | None  # set only when re-ranking was applied
    query_terms: list[str]
    keyword: list[Candidate] = field(default_factory=list)
    semantic: list[Candidate] = field(default_factory=list)
    fused: list[Candidate] = field(default_factory=list)  # hybrid mode only
    reranked: list[Candidate] | None = None
    results: list[Candidate] = field(default_factory=list)  # final ranking, top_k
    confidence: Confidence = Confidence(None, None, 0.0, False)
    notice: str | None = None
    # The part of ``notice`` that says documents were left out (still true for a confident result).
    partial_notice: str | None = None
    timings: dict[str, float] = field(default_factory=dict)

    @property
    def low_confidence(self) -> bool:
        return not self.confidence.confident

    def chunk(self, candidate: Candidate) -> IndexedChunk:
        return self.index.chunks[candidate.row]

    def vector(self, candidate: Candidate) -> np.ndarray:
        return self.index.matrix[candidate.row]

    def hits(self, candidates: Sequence[Candidate], limit: int | None = None) -> list[Hit]:
        terms = frozenset(self.query_terms)
        selected = candidates if limit is None else candidates[:limit]
        return [Hit(**_hit_fields(self, c, rank, terms)) for rank, c in enumerate(selected, start=1)]

    def evidence(self, first_ref: int = 1, candidates: Sequence[Candidate] | None = None) -> list[Evidence]:
        """Results as citable evidence; ``ref`` is the number used in ``[n]`` citations."""
        terms = frozenset(self.query_terms)
        selected = self.results if candidates is None else candidates
        return [
            Evidence(**_hit_fields(self, c, rank, terms), ref=first_ref + rank - 1)
            for rank, c in enumerate(selected, start=1)
        ]

    def effective_settings(self) -> EffectiveSettings:
        p = self.params
        return EffectiveSettings(
            mode=p.mode,  # type: ignore[arg-type]
            top_k=p.top_k,
            candidates=p.candidates,
            rrf_k=p.rrf_k,
            lexical_weight=p.lexical_weight,
            vector_weight=p.vector_weight,
            reranked=self.reranked is not None,
            rerank_candidates=p.rerank_candidates,
            bm25_k1=p.bm25_k1,
            bm25_b=p.bm25_b,
            embedding_version=self.embedder.version,
            reranker=self.reranker_name,
            index_version=self.index.index_version,
        )


def _hit_fields(retrieval: Retrieval, candidate: Candidate, rank: int, terms: frozenset[str]) -> dict[str, object]:
    chunk = retrieval.chunk(candidate)
    return {
        "chunk_id": chunk.chunk_id,
        "document_id": chunk.document_id,
        "document_title": chunk.document_title,
        "document_kind": chunk.document_kind,
        "locator_kind": locator_kind(chunk.document_kind),
        "page_number": chunk.page_number,
        "page_label": chunk.page_label,
        "char_start": chunk.char_start,
        "char_end": chunk.char_end,
        "text": chunk.text,
        "rank": rank,
        "scores": HitScores(
            keyword=candidate.keyword, semantic=candidate.semantic, fused=candidate.fused, rerank=candidate.rerank
        ),
        "matched_terms": matched_surfaces(chunk.text, terms) if terms else [],
    }


def clean_query(query: str, settings: Settings) -> str:
    query = query.strip()
    if not query:
        raise ApiError(422, "invalid_request", "The query is empty.")
    if len(query) > settings.max_query_chars:
        raise ApiError(
            422, "invalid_request", f"The query is too long (maximum {settings.max_query_chars} characters)."
        )
    return query


def is_relevant(
    params: RetrievalParams, *, similarity: float | None, rerank: float | None, coverage: float, reranked: bool
) -> bool:
    """The relevance rules from the module docstring, applied to one passage.

    ``reranked`` says whether re-ranking ran for this query: passages outside the re-ranked pool
    then have no cross-encoder score and are not counted as evidence.
    """
    if reranked:
        return rerank is not None and rerank >= params.min_rerank_score
    if coverage >= FULL_KEYWORD_COVERAGE:
        return True
    return similarity is not None and similarity >= params.min_vector_similarity


def assess(params: RetrievalParams, results: Sequence[Candidate], *, reranked: bool) -> Confidence:
    """Judge the final results: confident when at least one passage is relevant on its own."""
    for c in results:
        c.relevant = is_relevant(
            params, similarity=c.similarity, rerank=c.rerank, coverage=c.coverage, reranked=reranked
        )
    return Confidence(
        best_similarity=max((c.similarity for c in results if c.similarity is not None), default=None),
        best_rerank=max((c.rerank for c in results if c.rerank is not None), default=None),
        keyword_coverage=max((c.coverage for c in results), default=0.0),
        confident=any(c.relevant for c in results),
    )


def _empty_index_notice(conn: Connection, collection_id: str, stale_documents: int) -> str:
    total, in_progress = conn.execute(
        select(
            func.count(),
            func.count().filter(documents.c.status.in_(("uploaded", "processing"))),
        ).where(documents.c.collection_id == collection_id)
    ).one()
    if not total:
        return NOTICE_NO_DOCUMENTS
    if stale_documents:
        return NOTICE_ALL_STALE
    if in_progress:
        return NOTICE_INDEXING
    return NOTICE_NOTHING_INDEXED


def _ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000.0, 3)


def retrieve(
    conn: Connection,
    user: User,
    *,
    query: str,
    collection_id: str,
    params: RetrievalParams,
    settings: Settings,
    document_ids: Sequence[str] | None = None,
    embedder: Embedder | None = None,
    reranker: Reranker | None = None,
    query_vector: np.ndarray | None = None,
) -> Retrieval:
    """Run the retrieval pipeline for one query against one collection owned by ``user``.

    ``embedder``/``reranker`` default to the configured models (the evaluation harness passes its
    own); ``query_vector`` lets a caller that searches several collections embed the query once.
    """
    total_started = time.perf_counter()
    query = clean_query(query, settings)
    require_collection(conn, user, collection_id)
    if document_ids:
        selected = require_documents(conn, user, document_ids)
        if any(row.collection_id != collection_id for row in selected):
            raise ApiError(422, "invalid_request", "Every selected document must belong to the searched collection.")
    else:
        document_ids = None

    embedder = embedder or registry.get_embedder()
    timings = dict.fromkeys(("index", "embed", "keyword", "semantic", "fuse", "rerank", "total"), 0.0)

    started = time.perf_counter()
    index, cached = index_module.get_index(conn, collection_id, embedder.version)
    timings["index"] = _ms(started)

    terms = query_terms(query)
    result = Retrieval(
        query=query,
        params=params,
        index=index,
        cached=cached,
        embedder=embedder,
        reranker_name=None,
        query_terms=terms,
        timings=timings,
    )
    stale = index.stats.stale_documents
    if not len(index):
        result.notice = _empty_index_notice(conn, collection_id, stale)
        timings["total"] = _ms(total_started)
        return result
    mask = index.mask_for(document_ids)
    if mask is not None and not mask.any():
        result.notice = NOTICE_SELECTION_EMPTY
        timings["total"] = _ms(total_started)
        return result

    by_row: dict[int, Candidate] = {}

    def candidate(row: int) -> Candidate:
        found = by_row.get(row)
        if found is None:
            found = by_row[row] = Candidate(row)
        return found

    if params.mode in ("keyword", "hybrid"):
        started = time.perf_counter()
        hits = index.keyword(terms, k1=params.bm25_k1, b=params.bm25_b, limit=params.candidates, mask=mask)
        for rank, hit in enumerate(hits, start=1):
            entry = candidate(hit.row)
            entry.keyword = StageScore(rank=rank, score=hit.score)
            result.keyword.append(entry)
        timings["keyword"] = _ms(started)

    similarities: np.ndarray | None = None
    if params.mode in ("semantic", "hybrid"):
        started = time.perf_counter()
        if query_vector is None:
            query_vector = embedder.embed_query(query)
        timings["embed"] = _ms(started)
        started = time.perf_counter()
        similarities = index.similarities(query_vector)
        for rank, (row, score) in enumerate(index.semantic(similarities, limit=params.candidates, mask=mask), 1):
            entry = candidate(row)
            entry.semantic = StageScore(rank=rank, score=score)
            result.semantic.append(entry)
        timings["semantic"] = _ms(started)

    if params.mode == "hybrid":
        started = time.perf_counter()
        fused = weighted_rrf(
            [[c.row for c in result.keyword], [c.row for c in result.semantic]],
            [params.lexical_weight, params.vector_weight],
            params.rrf_k,
            tiebreak=lambda row: int(index.tiebreak[row]),
        )
        for row, score in fused:
            entry = by_row[row]
            entry.fused = score
            result.fused.append(entry)
        ranking = result.fused
        timings["fuse"] = _ms(started)
    else:
        ranking = result.keyword if params.mode == "keyword" else result.semantic

    if params.rerank and ranking:
        reranker = reranker or registry.get_reranker()
        if reranker is not None:
            started = time.perf_counter()
            pool = ranking[: params.rerank_candidates]
            scores = reranker.score(query, [index.chunks[c.row].text for c in pool])
            for entry, score in zip(pool, scores, strict=True):
                entry.rerank = float(score)
            result.reranked = sorted(pool, key=lambda c: (-(c.rerank or 0.0), int(index.tiebreak[c.row])))
            result.reranker_name = f"{reranker.backend}:{reranker.model}"
            # Passages beyond the re-ranked pool keep their order after it, so top_k may exceed the pool.
            ranking = result.reranked + ranking[len(pool) :]
            timings["rerank"] = _ms(started)

    result.results = ranking[: params.top_k]
    rows = [c.row for c in result.results]
    for entry, coverage in zip(result.results, index.bm25.coverage(terms, rows), strict=True):
        entry.coverage = coverage
        entry.similarity = float(similarities[entry.row]) if similarities is not None else None
    result.confidence = assess(params, result.results, reranked=result.reranked is not None)
    notices: list[str] = []
    if not rows:
        notices.append(NOTICE_NO_MATCH)
    elif result.low_confidence:
        notices.append(NOTICE_LOW_CONFIDENCE)
    if stale:
        result.partial_notice = notice_stale(stale)
        notices.append(result.partial_notice)
    result.notice = " ".join(notices) or None
    timings["total"] = _ms(total_started)
    return result


def run_search(conn: Connection, user: User, body: SearchIn, settings: Settings) -> SearchOut:
    params = RetrievalParams.from_settings(settings, mode=body.mode, top_k=body.top_k, rerank=body.rerank)
    result = retrieve(
        conn,
        user,
        query=body.query,
        collection_id=body.collection_id,
        document_ids=body.document_ids,
        params=params,
        settings=settings,
    )
    return SearchOut(
        query=result.query,
        results=result.hits(result.results),
        low_confidence=result.low_confidence,
        notice=result.notice,
        settings=result.effective_settings(),
        timings_ms=result.timings,
    )
