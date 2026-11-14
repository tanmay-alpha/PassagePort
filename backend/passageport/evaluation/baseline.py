"""Benchmark the actual upstream classes, not swapped models in PassagePort's pipeline.

The upstream checkout is read-only. Its raw-file semchunk(512), unnormalized embeddings,
LanceDB default L2 top-20 and CrossEncoder.predict path are intentionally left unchanged.
Only logs and the scratch database location are changed for privacy and isolation.
"""

from __future__ import annotations

import hashlib
import importlib
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from passageport.evaluation import harness, metrics
from passageport.evaluation.datasets import EvalCorpus, EvalQuery, load_corpus


def _relevant(query: EvalQuery, corpus: EvalCorpus, rows: list[dict[str, Any]]) -> frozenset[str]:
    if corpus.relevance == "document":
        return query.relevant_documents
    source = {d.doc_id: d.data.decode("utf-8") for d in corpus.documents}
    relevant = set()
    for row in rows:
        start, end = row["chunk_offset"], row["chunk_offset"] + len(row["content"])
        for quote in query.quotes:
            if quote.document != row["source_document"]:
                continue
            position = source[quote.document].find(quote.quote)
            if position < 0:
                raise ValueError(f"query {query.query_id}: quote is not present in the raw upstream input")
            if start < position + len(quote.quote) and end > position:
                relevant.add(row["chunk_id"])
    return frozenset(relevant)


def _summary(records: list[tuple[list[str], frozenset[str], float, bool]]) -> dict[str, Any]:
    scored = [(ranking, relevant) for ranking, relevant, _, answerable in records if answerable]
    latencies = [latency for _, _, latency, _ in records]
    return {
        "name": "upstream vector20+rerank",
        "queries": len(scored),
        "recall_at_k": {
            str(k): round(metrics.mean([metrics.recall_at_k(r, rel, k) for r, rel in scored]), 4)
            for k in harness.RECALL_KS
        },
        "precision_at_k": {
            str(k): round(metrics.mean([metrics.precision_at_k(r, rel, k) for r, rel in scored]), 4)
            for k in harness.PRECISION_KS
        },
        "mrr": round(metrics.mean([metrics.reciprocal_rank(r[:10], rel) for r, rel in scored]), 4),
        "ndcg_at_10": round(metrics.mean([metrics.ndcg_at_k(r, rel, 10) for r, rel in scored]), 4),
        "latency_ms_p50": round(metrics.percentile(latencies, 50), 2),
        "latency_ms_p95": round(metrics.percentile(latencies, 95), 2),
        "confidence_supported": False,
        "out_of_scope_returned_results": sum(bool(r) for r, _, _, answerable in records if not answerable),
    }


def _dataset(args: Any, corpus: EvalCorpus, manager: Any, processor: Any, database: Any) -> dict[str, Any]:
    database.create_index(corpus.name)
    chunk_seconds = embed_seconds = 0.0
    total_chunks = 0
    for document in corpus.documents:
        started = time.perf_counter()
        texts, offsets = processor.chunk_document(document.data.decode("utf-8"))
        chunk_seconds += time.perf_counter() - started
        started = time.perf_counter()
        vectors = manager.encode(texts)
        embed_seconds += time.perf_counter() - started
        database.add_chunks(
            corpus.name, texts, vectors, document.doc_id, offsets, [manager.count_tokens(t) for t in texts]
        )
        total_chunks += len(texts)
    rows = database._get_table(corpus.name).to_arrow().to_pylist()
    records = []
    for position, query in enumerate(corpus.queries):
        # As with the main harness, warm query execution is excluded from headline latency.
        if position == 0:
            vector = manager.encode_query(query.text)
            warm = database.vector_search(corpus.name, vector, limit=20)
            manager.rerank(query.text, [r["content"] for r in warm], top_k=harness.EVAL_TOP_K)
        started = time.perf_counter()
        vector = manager.encode_query(query.text)
        candidates = database.vector_search(corpus.name, vector, limit=20)
        reranked = manager.rerank(query.text, [r["content"] for r in candidates], top_k=harness.EVAL_TOP_K)
        ranking = [candidates[i] for i, _ in reranked]
        latency = (time.perf_counter() - started) * 1000
        ids = [r["chunk_id"] for r in ranking]
        if corpus.relevance == "document":
            ids = list(dict.fromkeys(r["source_document"] for r in ranking))
        records.append((ids, _relevant(query, corpus, rows), latency, query.answerable))
    summary = _summary(records)
    summary["observations"] = [
        {
            "query_id": query.query_id,
            "answerable": answerable,
            "ranked_ids": ranking,
            "relevant_ids": sorted(relevant),
            "latency_ms": round(latency, 3),
        }
        for query, (ranking, relevant, latency, answerable) in zip(corpus.queries, records, strict=True)
    ]
    return {
        "name": corpus.name,
        "description": corpus.description + " Original upstream raw-file pipeline; quote-overlap relevance.",
        "relevance": corpus.relevance,
        "documents": len(corpus.documents),
        "chunks": total_chunks,
        "queries": sum(q.answerable for q in corpus.queries),
        "out_of_scope_queries": sum(not q.answerable for q in corpus.queries),
        "chunk_seconds": round(chunk_seconds, 3),
        "embed_seconds": round(embed_seconds, 3),
        "indexing_chunks_per_second": round(total_chunks / (chunk_seconds + embed_seconds), 1),
        "embedding_chunks_per_second": round(total_chunks / embed_seconds, 1),
        "runs": [summary],
        "settings": {"chunk_max_tokens": 512, "candidates": 20, "rerank_candidates": 20,
                     "vector_distance": "LanceDB default L2", "normalized_embeddings": False},
    }


def run(args: Any, header: dict[str, Any]) -> dict[str, Any]:
    root = Path(args.upstream_root).resolve()
    if not (root / "app" / "services.py").is_file():
        raise ValueError("--upstream-root must point to the original upstream backend checkout")
    sys.path.insert(0, str(root))
    from loguru import logger

    logger.remove()  # Upstream logs query/document details; benchmark output must not.
    config = importlib.import_module("app.config")
    services = importlib.import_module("app.services")
    db_module = importlib.import_module("app.database")
    config.settings.max_chunk_tokens = 512
    config.settings.embedding_model = "Alibaba-NLP/gte-multilingual-base"
    config.settings.reranker_model = "Alibaba-NLP/gte-multilingual-reranker-base"
    manager = services.ModelManager()
    started = time.perf_counter()
    manager.encode_query("warm-up")
    embedding = {
        "spec": "sentence-transformers:" + config.settings.embedding_model,
        "version": "upstream:" + config.settings.embedding_model,
        "dimensions": manager.embedding_model.get_sentence_embedding_dimension(),
        "load_seconds": round(time.perf_counter() - started, 2),
    }
    started = time.perf_counter()
    manager.rerank("warm-up", ["warm-up"])
    reranker = {
        "spec": "sentence-transformers:" + config.settings.reranker_model,
        "load_seconds": round(time.perf_counter() - started, 2),
    }
    for info in (embedding, reranker):
        model = SimpleNamespace(backend="sentence-transformers", model=info["spec"].split(":", 1)[1], _cache_dir=None)
        size = harness.model_size_bytes(model)
        info["size_mb"] = round(size / 1024**2, 1) if size is not None else None
    payload = header | {
        "label": "Original upstream a0d8c06",
        "upstream_commit": "a0d8c06",
        "upstream_source_sha256": {
            path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted((root / "app").glob("*.py"))
        },
        "pipeline": "original DocumentProcessor + ModelManager + LanceDBManager, raw semchunk512, L2 top20, rerank",
        "embedding": embedding,
        "reranker": reranker,
        "datasets": [],
    }
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="upstream-", dir=args.cache_dir) as scratch:
        config.settings.lancedb_path = scratch
        processor = services.DocumentProcessor(manager)
        database = db_module.LanceDBManager()
        for name in args.datasets:
            corpus = load_corpus(name, cache_dir=args.cache_dir, max_queries=args.max_queries)
            payload["datasets"].append(_dataset(args, corpus, manager, processor, database))
        database._tables.clear()
        database._db = None
    payload["peak_rss_mb"] = harness.peak_rss_mb()
    return payload
