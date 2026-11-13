"""Evaluation harness: index a corpus and run queries through the production code.

Nothing here re-implements retrieval. A corpus is parsed by ``passageport.parsing``, chunked by
``passageport.chunking.chunk_pages``, embedded by the selected model backend and written to a
scratch SQLite database with the application's own schema. Queries then go through
``passageport.search.service.retrieve`` — the function behind /api/search — so the tokenizer,
BM25, fusion, re-ranking, tie-breaking and confidence rules measured are the ones that ship.
"""

from __future__ import annotations

import hashlib
import json
import platform
import re
import shutil
import subprocess
import sys
import time
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from sqlalchemy import Engine, insert, select

from passageport.config import Settings
from passageport.db.engine import create_db_engine
from passageport.db.schema import chunks, collections, documents, pages, users, utcnow
from passageport.domain import User
from passageport.evaluation import metrics
from passageport.evaluation.datasets import EvalCorpus, EvalQuery
from passageport.ml.protocols import Embedder, Reranker, to_blob
from passageport.search import index as index_module
from passageport.search import tokenize as tokenize_module
from passageport.search.service import Confidence, RetrievalParams, retrieve

EVAL_TOP_K = 20  # passages requested per query; metrics use the first 10 (documents for SciFact)
RECALL_KS = (1, 5, 10)
PRECISION_KS = (1, 5)
RUN_NAMES = ("keyword", "semantic", "hybrid", "hybrid+rerank", "semantic+rerank")


# --------------------------------------------------------------------------- models


@dataclass(frozen=True, slots=True)
class ModelSpec:
    backend: str  # fastembed | sentence-transformers | hashing
    model: str

    @classmethod
    def parse(cls, text: str) -> ModelSpec:
        backend, _, model = text.partition(":")
        if backend not in ("fastembed", "sentence-transformers", "hashing") or (backend != "hashing" and not model):
            raise ValueError(f"model must look like 'fastembed:<name>' or 'sentence-transformers:<name>', got {text!r}")
        return cls(backend, model)

    def __str__(self) -> str:
        return f"{self.backend}:{self.model}" if self.model else self.backend


def make_embedder(spec: ModelSpec, cache_dir: Path | None = None) -> Embedder:
    if spec.backend == "hashing":
        from passageport.ml.hashing import HashingEmbedder

        return HashingEmbedder()
    if spec.backend == "fastembed":
        from passageport.ml.fastembed_backend import FastEmbedEmbedder

        return FastEmbedEmbedder(spec.model, cache_dir=cache_dir)
    from passageport.ml.st_backend import SentenceTransformerEmbedder

    return SentenceTransformerEmbedder(spec.model, cache_dir=cache_dir)


def make_reranker(spec: ModelSpec, cache_dir: Path | None = None) -> Reranker:
    if spec.backend == "fastembed":
        from passageport.ml.fastembed_backend import FastEmbedReranker

        return FastEmbedReranker(spec.model, cache_dir=cache_dir)
    from passageport.ml.st_backend import SentenceTransformerReranker

    return SentenceTransformerReranker(spec.model, cache_dir=cache_dir)


def directory_size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def model_size_bytes(model: Any) -> int | None:
    """Size on disk of a loaded model's files, or ``None`` when the backend keeps none."""
    directory = getattr(model, "model_dir", None)
    if directory is None and getattr(model, "backend", "") == "sentence-transformers":
        try:
            from huggingface_hub import snapshot_download

            directory = snapshot_download(model.model, local_files_only=True, cache_dir=model._cache_dir)
        except Exception:  # noqa: BLE001 - size is informational
            return None
    return directory_size(Path(directory)) if directory else None


class CachingReranker:
    """Remembers scores per (query, passage) so parameter sweeps do not re-run the cross-encoder.

    Only used for sweeps; latency of the headline runs is measured on the bare model.
    """

    def __init__(self, inner: Reranker) -> None:
        self.backend = inner.backend
        self.model = inner.model
        self._inner = inner
        self._scores: dict[tuple[str, str], float] = {}

    def score(self, query: str, passages: list[str]) -> list[float]:
        missing = [p for p in dict.fromkeys(passages) if (query, p) not in self._scores]
        if missing:
            for passage, score in zip(missing, self._inner.score(query, missing), strict=True):
                self._scores[(query, passage)] = score
        return [self._scores[(query, p)] for p in passages]


# --------------------------------------------------------------------------- environment


def _cpu_name() -> str:
    if sys.platform == "win32":
        try:
            import winreg

            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
            return str(winreg.QueryValueEx(key, "ProcessorNameString")[0]).strip()
        except OSError:
            pass
    try:
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8").splitlines():
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or platform.machine()


def _psutil() -> Any:
    try:
        import psutil
    except ImportError:
        raise SystemExit("The evaluation harness needs psutil: install the dev extras (uv sync --extra dev).") from None
    return psutil


def hardware_string() -> str:
    psutil = _psutil()
    ram_gb = psutil.virtual_memory().total / 1024**3
    return (
        f"{_cpu_name()}, {psutil.cpu_count(logical=True)} threads, {ram_gb:.0f} GB RAM, CPU only, "
        f"{platform.system()} {platform.release()}, Python {platform.python_version()}"
    )


def peak_rss_mb() -> float:
    info = _psutil().Process().memory_info()
    peak = getattr(info, "peak_wset", None)  # Windows
    if peak is None:
        import resource

        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)
    return round(peak / 1024**2, 1)


def git_commit() -> str | None:
    git = shutil.which("git")
    if git is None:
        return None
    try:
        out = subprocess.run(  # noqa: S603 - fixed arguments
            [git, "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=10, check=True, cwd=Path(__file__).parent,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() or None


def package_versions() -> dict[str, str]:
    from importlib.metadata import PackageNotFoundError, version

    found = {}
    for name in ("fastembed", "onnxruntime", "numpy", "semchunk", "sentence-transformers", "torch", "transformers"):
        try:
            found[name] = version(name)
        except PackageNotFoundError:
            continue
    return found


@contextmanager
def stemming(mode: str) -> Iterator[None]:
    """Temporarily switch the keyword tokenizer's stemming (tokenizer experiments only)."""
    previous = tokenize_module.STEMMING
    tokenize_module.STEMMING = mode
    index_module.clear_cache()
    try:
        yield
    finally:
        tokenize_module.STEMMING = previous
        index_module.clear_cache()


# --------------------------------------------------------------------------- indexing


def eval_settings(data_dir: Path, **overrides: Any) -> Settings:
    """Application defaults (no .env file), pointed at a scratch directory."""
    return Settings(_env_file=None, data_dir=data_dir, **overrides)  # type: ignore[call-arg]


@dataclass(slots=True)
class EvalIndex:
    corpus: EvalCorpus
    engine: Engine
    settings: Settings
    user: User
    collection_id: str
    embedding_version: str
    chunker_version: str
    document_count: int
    page_count: int
    chunk_count: int
    chunk_seconds: float  # parsing + chunking
    embed_seconds: float
    reused: bool  # loaded from the on-disk cache; timings are those of the original build
    chunk_to_document: dict[str, str] = field(default_factory=dict)  # chunk id -> corpus doc id
    document_ids: dict[str, str] = field(default_factory=dict)  # corpus doc id -> database id
    _relevant: dict[str, frozenset[str]] = field(default_factory=dict)

    @property
    def indexing_chunks_per_second(self) -> float:
        total = self.chunk_seconds + self.embed_seconds
        return round(self.chunk_count / total, 1) if total else 0.0

    @property
    def embedding_chunks_per_second(self) -> float:
        return round(self.chunk_count / self.embed_seconds, 1) if self.embed_seconds else 0.0

    def relevant_ids(self, query: EvalQuery) -> frozenset[str]:
        """Ids that count as a correct hit: corpus documents, or chunks containing a labelled quote."""
        if self.corpus.relevance == "document":
            return query.relevant_documents
        if query.query_id not in self._relevant:
            self._relevant[query.query_id] = self._chunks_with_quotes(query)
        return self._relevant[query.query_id]

    def _chunks_with_quotes(self, query: EvalQuery) -> frozenset[str]:
        found: set[str] = set()
        with self.engine.connect() as conn:
            for quote in query.quotes:
                document_id = self.document_ids[quote.document]
                located = False
                for page in conn.execute(select(pages).where(pages.c.document_id == document_id)):
                    start = page.text.find(quote.quote)
                    if start < 0:
                        continue
                    located = True
                    end = start + len(quote.quote)
                    rows = conn.execute(
                        select(chunks.c.id).where(
                            chunks.c.document_id == document_id,
                            chunks.c.page_number == page.page_number,
                            chunks.c.char_start < end,
                            chunks.c.char_end > start,
                        )
                    )
                    found.update(r.id for r in rows)
                if not located:
                    raise ValueError(f"query {query.query_id}: quote not found in {quote.document}")
        return frozenset(found)


def _slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9.]+", "-", text).strip("-")


def _database_id(corpus: str, doc_id: str) -> str:
    return hashlib.sha256(f"{corpus}:{doc_id}".encode()).hexdigest()[:32]


def build_eval_index(
    corpus: EvalCorpus,
    embedder: Embedder,
    workdir: Path,
    *,
    chunk_max_tokens: int | None = None,
    rebuild: bool = False,
    settings_overrides: dict[str, Any] | None = None,
) -> EvalIndex:
    """Index ``corpus`` into a scratch database under ``workdir`` (reused on later calls)."""
    from passageport.chunking import chunk_id, chunk_pages, chunker_version
    from passageport.parsing import limits_from, parse_in_process

    overrides = dict(settings_overrides or {})
    if chunk_max_tokens is not None:
        overrides["chunk_max_tokens"] = chunk_max_tokens
    probe = eval_settings(workdir, **overrides)
    version = chunker_version(probe)
    directory = workdir / _slug(f"{corpus.name}-{len(corpus.documents)}d-{embedder.version}-{version}")
    meta_path = directory / "meta.json"
    if rebuild and directory.exists():
        shutil.rmtree(directory)
    settings = eval_settings(directory, **overrides)
    user = User(id="evaluation", username="evaluation")
    # Unique per scratch database: the process-wide index cache is keyed by collection id.
    collection_id = _database_id(corpus.name, directory.name)
    document_ids = {d.doc_id: _database_id(corpus.name, d.doc_id) for d in corpus.documents}
    by_database_id = {v: k for k, v in document_ids.items()}

    if meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        engine = create_db_engine(settings)
        with engine.connect() as conn:
            mapping = {r.id: by_database_id[r.document_id] for r in conn.execute(select(chunks.c.id, chunks.c.document_id))}
        return EvalIndex(
            corpus, engine, settings, user, collection_id, embedder.version, version,
            meta["documents"], meta["pages"], meta["chunks"], meta["chunk_seconds"], meta["embed_seconds"],
            True, mapping, document_ids,
        )

    if directory.exists():
        shutil.rmtree(directory)  # an interrupted build
    engine = create_db_engine(settings)
    limits = limits_from(settings)
    started = time.perf_counter()
    parsed = []
    for document in corpus.documents:
        document_pages = parse_in_process(document.kind, document.data, limits, document.title)
        parsed.append((document, document_pages, chunk_pages(document_pages, embedder, settings)))
    chunk_seconds = time.perf_counter() - started

    texts = [draft.text for _, _, drafts in parsed for draft in drafts]
    started = time.perf_counter()
    batches = [
        np.asarray(embedder.embed_documents(texts[i : i + settings.embed_batch_size]), dtype=np.float32)
        for i in range(0, len(texts), settings.embed_batch_size)
    ]
    embed_seconds = time.perf_counter() - started
    vectors = np.concatenate(batches) if batches else np.zeros((0, embedder.dimensions), dtype=np.float32)

    now = utcnow()
    mapping: dict[str, str] = {}
    page_total = 0
    with engine.begin() as conn:
        conn.execute(insert(users), [{"id": user.id, "username": user.username, "is_guest": False, "created_at": now}])
        conn.execute(
            insert(collections),
            [{"id": collection_id, "owner_id": user.id, "name": corpus.name, "description": "",
              "index_version": 1, "created_at": now, "updated_at": now}],
        )
        cursor = 0
        chunk_rows: list[dict[str, Any]] = []
        for document, document_pages, drafts in parsed:
            database_id = document_ids[document.doc_id]
            page_total += len(document_pages)
            conn.execute(
                insert(documents),
                [{
                    "id": database_id, "collection_id": collection_id, "owner_id": user.id,
                    "title": document.title[:255], "filename": f"{_slug(document.doc_id)[:200]}.{document.kind}",
                    "kind": document.kind, "size_bytes": len(document.data),
                    "sha256": hashlib.sha256(document.data + document.doc_id.encode()).hexdigest(),
                    "blob_key": database_id, "status": "indexed", "page_count": len(document_pages),
                    "chunk_count": len(drafts), "token_count": sum(d.token_count for d in drafts),
                    "embedding_version": embedder.version, "chunker_version": version,
                    "created_at": now, "updated_at": now, "indexed_at": now,
                }],
            )
            conn.execute(
                insert(pages),
                [{"document_id": database_id, "page_number": p.number, "label": p.label, "text": p.text}
                 for p in document_pages],
            )
            for draft in drafts:
                identifier = chunk_id(database_id, draft, version)
                mapping[identifier] = document.doc_id
                chunk_rows.append({
                    "id": identifier, "document_id": database_id, "collection_id": collection_id,
                    "ordinal": draft.ordinal, "page_number": draft.page_number, "char_start": draft.char_start,
                    "char_end": draft.char_end, "text": draft.text, "token_count": draft.token_count,
                    "embedding": to_blob(vectors[cursor]), "embedding_version": embedder.version,
                })
                cursor += 1
        for i in range(0, len(chunk_rows), 500):
            conn.execute(insert(chunks), chunk_rows[i : i + 500])
    meta = {
        "documents": len(corpus.documents), "pages": page_total, "chunks": len(mapping),
        "chunk_seconds": round(chunk_seconds, 3), "embed_seconds": round(embed_seconds, 3),
    }
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    return EvalIndex(
        corpus, engine, settings, user, collection_id, embedder.version, version,
        meta["documents"], meta["pages"], meta["chunks"], meta["chunk_seconds"], meta["embed_seconds"],
        False, mapping, document_ids,
    )


# --------------------------------------------------------------------------- running queries


@dataclass(frozen=True, slots=True)
class RunConfig:
    name: str
    mode: str
    rerank: bool

    @classmethod
    def named(cls, name: str) -> RunConfig:
        mode, _, suffix = name.partition("+")
        if name not in RUN_NAMES:
            raise ValueError(f"unknown run {name!r}; choose from {RUN_NAMES}")
        return cls(name, mode, suffix == "rerank")


@dataclass(frozen=True, slots=True)
class Outcome:
    query: EvalQuery
    ranked: tuple[str, ...]  # chunk ids, or distinct corpus document ids
    latency_ms: float
    confidence: Confidence


def params_for(index: EvalIndex, config: RunConfig, **overrides: Any) -> RetrievalParams:
    values = {"mode": config.mode, "rerank": config.rerank, "top_k": EVAL_TOP_K, **overrides}
    return RetrievalParams.from_settings(index.settings, **values)


def run_queries(
    index: EvalIndex,
    queries: Sequence[EvalQuery],
    params: RetrievalParams,
    embedder: Embedder,
    reranker: Reranker | None,
    *,
    query_vectors: dict[str, np.ndarray] | None = None,
    document_filter: dict[str, list[str]] | None = None,
) -> list[Outcome]:
    """Run every query through ``retrieve``. ``query_vectors`` (sweeps only) skips re-embedding."""
    if params.rerank and reranker is None:
        raise ValueError("this run needs a re-ranker")
    outcomes: list[Outcome] = []
    with index.engine.connect() as conn:
        for query in queries:
            started = time.perf_counter()
            result = retrieve(
                conn,
                index.user,
                query=query.text,
                collection_id=index.collection_id,
                document_ids=document_filter.get(query.query_id) if document_filter else None,
                params=params,
                settings=index.settings,
                embedder=embedder,
                reranker=reranker,
                query_vector=query_vectors.get(query.text) if query_vectors else None,
            )
            latency = (time.perf_counter() - started) * 1000.0
            ids = [result.chunk(c).chunk_id for c in result.results]
            if index.corpus.relevance == "document":
                ids = list(dict.fromkeys(index.chunk_to_document[i] for i in ids))
            outcomes.append(Outcome(query, tuple(ids), latency, result.confidence))
    return outcomes


def _ranking_metrics(scored: Sequence[tuple[Outcome, frozenset[str]]]) -> dict[str, Any]:
    return {
        "queries": len(scored),
        "recall_at_k": {
            str(k): round(metrics.mean([metrics.recall_at_k(o.ranked, rel, k) for o, rel in scored]), 4)
            for k in RECALL_KS
        },
        "precision_at_k": {
            str(k): round(metrics.mean([metrics.precision_at_k(o.ranked, rel, k) for o, rel in scored]), 4)
            for k in PRECISION_KS
        },
        "mrr": round(metrics.mean([metrics.reciprocal_rank(o.ranked[:10], rel) for o, rel in scored]), 4),
        "ndcg_at_10": round(metrics.mean([metrics.ndcg_at_k(o.ranked, rel, 10) for o, rel in scored]), 4),
    }


def summarize(index: EvalIndex, outcomes: Sequence[Outcome], *, by_kind: bool = True) -> dict[str, Any]:
    """Macro-averaged metrics over answerable queries, latency over all, refusal counts for both."""
    scored = [(o, index.relevant_ids(o.query)) for o in outcomes if o.query.answerable]
    summary = _ranking_metrics(scored)
    latencies = [o.latency_ms for o in outcomes]
    summary["latency_ms_p50"] = round(metrics.percentile(latencies, 50), 2)
    summary["latency_ms_p95"] = round(metrics.percentile(latencies, 95), 2)
    kinds = sorted({o.query.kind for o, _ in scored})
    if by_kind and len(kinds) > 1:
        summary["by_kind"] = {k: _ranking_metrics([(o, r) for o, r in scored if o.query.kind == k]) for k in kinds}
    unanswerable = [o for o in outcomes if not o.query.answerable]
    summary["low_confidence"] = {
        "answerable_flagged": sum(1 for o, _ in scored if not o.confidence.confident),
        "answerable_total": len(scored),
        "out_of_scope_flagged": sum(1 for o in unanswerable if not o.confidence.confident),
        "out_of_scope_total": len(unanswerable),
    }
    return summary


def confidence_record(outcome: Outcome) -> dict[str, Any]:
    return {"query_id": outcome.query.query_id, "kind": outcome.query.kind, **asdict(outcome.confidence)}
