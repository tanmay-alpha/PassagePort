"""Evaluation command line.

    uv run python -m passageport.evaluation.run evaluate  --datasets mini scifact --out ../eval/results/default.json
    uv run python -m passageport.evaluation.run sweep     --datasets mini scifact --out ../eval/results/sweep.json
    uv run python -m passageport.evaluation.run calibrate --out ../eval/results/calibration.json
    uv run python -m passageport.evaluation.run report    --inputs ../eval/results/default.json --out passageport/evaluation/report.json

``evaluate``   headline numbers for one model configuration (one process per configuration, so
               peak memory and load time belong to that configuration).
``sweep``      effect of chunk size, fusion and BM25 settings, tokenizer stemming, re-rank depth.
``calibrate``  score distributions of answerable vs unanswerable queries, for the confidence thresholds.
``report``     merge ``evaluate`` outputs into the report served by GET /api/lab/evaluation.
"""

from __future__ import annotations

import argparse
import json
import shlex
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from passageport.api.schemas import EvalDataset, EvalReport, EvalRun
from passageport.config import Settings
from passageport.evaluation import harness
from passageport.evaluation.datasets import DATASET_NAMES, DEFAULT_CACHE_DIR, EvalQuery, load_corpus
from passageport.evaluation.harness import ModelSpec, RunConfig
from passageport.search.service import FULL_KEYWORD_COVERAGE
from passageport.search.tokenize import STEMMING_MODES, TOKENIZER_NAME

_DEFAULTS = Settings(_env_file=None)  # type: ignore[call-arg]
DEFAULT_EMBEDDING = f"fastembed:{_DEFAULTS.embedding_model}"
DEFAULT_RERANKER = f"fastembed:{_DEFAULTS.reranker_model}"
DEFAULT_RUNS = ("keyword", "semantic", "hybrid", "hybrid+rerank")


def _command() -> str:
    launcher = "uv run python" if Path(sys.prefix).name == ".venv" else f"{Path(sys.prefix).name}/Scripts/python"
    return f"{launcher} -m passageport.evaluation.run {shlex.join(sys.argv[1:])}"


def _log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", file=sys.stderr, flush=True)


def _header() -> dict[str, Any]:
    return {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "git_commit": harness.git_commit(),
        "hardware": harness.hardware_string(),
        "command": _command(),
        "packages": harness.package_versions(),
        "tokenizer": TOKENIZER_NAME,
    }


def _write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    _log(f"wrote {path}")


def _load_models(args: argparse.Namespace, need_reranker: bool) -> tuple[Any, Any, dict[str, Any], dict[str, Any] | None]:
    spec = ModelSpec.parse(args.embedding)
    started = time.perf_counter()
    embedder = harness.make_embedder(spec, args.model_cache)
    embedder.embed_query("warm-up")
    embedding_info = {
        "spec": str(spec),
        "version": embedder.version,
        "dimensions": embedder.dimensions,
        "load_seconds": round(time.perf_counter() - started, 2),
        "size_mb": _megabytes(harness.model_size_bytes(embedder)),
    }
    _log(f"embedder ready: {embedder.version} ({embedding_info['load_seconds']} s)")
    reranker = None
    reranker_info = None
    if need_reranker and args.reranker != "none":
        reranker_spec = ModelSpec.parse(args.reranker)
        started = time.perf_counter()
        reranker = harness.make_reranker(reranker_spec, args.model_cache)
        reranker.score("warm-up", ["warm-up"])
        reranker_info = {
            "spec": str(reranker_spec),
            "load_seconds": round(time.perf_counter() - started, 2),
            "size_mb": _megabytes(harness.model_size_bytes(reranker)),
        }
        _log(f"re-ranker ready: {reranker_spec} ({reranker_info['load_seconds']} s)")
    return embedder, reranker, embedding_info, reranker_info


def _megabytes(size: int | None) -> float | None:
    return None if size is None else round(size / 1024**2, 1)


def _overrides(args: argparse.Namespace) -> dict[str, Any]:
    names = ("candidates", "rrf_k", "lexical_weight", "vector_weight", "rerank_candidates")
    return {n: getattr(args, n) for n in names if getattr(args, n, None) is not None}


def _settings_record(params: Any, index: harness.EvalIndex) -> dict[str, Any]:
    return {
        "chunk_max_tokens": index.settings.chunk_max_tokens,
        "chunk_overlap_tokens": index.settings.chunk_overlap_tokens,
        "top_k": params.top_k,
        "candidates": params.candidates,
        "rrf_k": params.rrf_k,
        "lexical_weight": params.lexical_weight,
        "vector_weight": params.vector_weight,
        "rerank_candidates": params.rerank_candidates,
        "bm25_k1": params.bm25_k1,
        "bm25_b": params.bm25_b,
        "min_vector_similarity": params.min_vector_similarity,
        "min_rerank_score": params.min_rerank_score,
    }


# --------------------------------------------------------------------------- evaluate


def cmd_evaluate(args: argparse.Namespace) -> int:
    configs = [RunConfig.named(name) for name in args.runs]
    embedder, reranker, embedding_info, reranker_info = _load_models(args, any(c.rerank for c in configs))
    if reranker is None:
        configs = [c for c in configs if not c.rerank]
    payload = _header() | {"label": args.label, "embedding": embedding_info, "reranker": reranker_info, "datasets": []}
    for name in args.datasets:
        corpus = load_corpus(name, cache_dir=args.cache_dir, max_queries=args.max_queries)
        _log(f"{name}: indexing {len(corpus.documents)} documents")
        index = harness.build_eval_index(
            corpus, embedder, args.cache_dir / "index", chunk_max_tokens=args.chunk_tokens, rebuild=args.rebuild
        )
        _log(f"{name}: {index.chunk_count} chunks, {index.indexing_chunks_per_second} chunks/s (reused={index.reused})")
        entry: dict[str, Any] = {
            "name": corpus.name,
            "description": corpus.description,
            "relevance": corpus.relevance,
            "documents": index.document_count,
            "pages": index.page_count,
            "chunks": index.chunk_count,
            "queries": sum(1 for q in corpus.queries if q.answerable),
            "out_of_scope_queries": sum(1 for q in corpus.queries if not q.answerable),
            "chunk_seconds": index.chunk_seconds,
            "embed_seconds": index.embed_seconds,
            "indexing_chunks_per_second": index.indexing_chunks_per_second,
            "embedding_chunks_per_second": index.embedding_chunks_per_second,
            "index_reused_from_cache": index.reused,
            "runs": [],
        }
        for config in configs:
            params = harness.params_for(index, config, **_overrides(args))
            harness.run_queries(index, corpus.queries[:2], params, embedder, reranker)  # warm caches
            outcomes = harness.run_queries(index, corpus.queries, params, embedder, reranker)
            summary = harness.summarize(index, outcomes)
            entry["runs"].append({"name": config.name, **summary})
            entry["settings"] = _settings_record(params, index)
            _log(
                f"{name} {config.name}: nDCG@10={summary['ndcg_at_10']} R@5={summary['recall_at_k']['5']} "
                f"MRR={summary['mrr']} p50={summary['latency_ms_p50']} ms"
            )
        payload["datasets"].append(entry)
    payload["peak_rss_mb"] = harness.peak_rss_mb()
    _write(args.out, payload)
    return 0


# --------------------------------------------------------------------------- sweep


def _compact(summary: dict[str, Any]) -> dict[str, Any]:
    return {
        "recall_at_1": summary["recall_at_k"]["1"],
        "recall_at_5": summary["recall_at_k"]["5"],
        "recall_at_10": summary["recall_at_k"]["10"],
        "mrr": summary["mrr"],
        "ndcg_at_10": summary["ndcg_at_10"],
    }


def cmd_sweep(args: argparse.Namespace) -> int:
    embedder, bare_reranker, embedding_info, reranker_info = _load_models(args, need_reranker=True)
    reranker = harness.CachingReranker(bare_reranker) if bare_reranker is not None else None
    rows: list[dict[str, Any]] = []
    payload = _header() | {"embedding": embedding_info, "reranker": reranker_info, "rows": rows}

    for name in args.datasets:
        corpus = load_corpus(name, cache_dir=args.cache_dir, max_queries=args.max_queries)
        queries = [q for q in corpus.queries if q.answerable]
        vectors = {q.text: embedder.embed_query(q.text) for q in queries}

        def measure(index: harness.EvalIndex, run: str, parameter: str, value: Any, **overrides: Any) -> None:
            config = RunConfig.named(run)
            if config.rerank and reranker is None:
                return
            params = harness.params_for(index, config, **overrides)
            outcomes = harness.run_queries(index, queries, params, embedder, reranker, query_vectors=vectors)  # noqa: B023
            summary = harness.summarize(index, outcomes, by_kind=False)
            rows.append({"dataset": name, "parameter": parameter, "value": value, "run": run,  # noqa: B023
                         "chunks": index.chunk_count, **_compact(summary)})
            _log(f"{name} {parameter}={value} {run}: nDCG@10={summary['ndcg_at_10']}")  # noqa: B023

        for size in args.chunk_sizes:
            index = harness.build_eval_index(corpus, embedder, args.cache_dir / "index", chunk_max_tokens=size)
            for run in DEFAULT_RUNS:
                measure(index, run, "chunk_max_tokens", size)

        index = harness.build_eval_index(corpus, embedder, args.cache_dir / "index")
        for rrf_k in (1, 10, 20, 40, 60, 100):
            measure(index, "hybrid", "rrf_k", rrf_k, rrf_k=rrf_k)
        for lexical, vector in ((1.0, 1.0), (0.5, 1.0), (0.7, 1.0), (1.0, 0.7), (1.0, 0.5), (1.0, 2.0), (2.0, 1.0)):
            measure(index, "hybrid", "lexical_weight:vector_weight", f"{lexical}:{vector}",
                    lexical_weight=lexical, vector_weight=vector)
        for candidates in (20, 30, 50, 100):
            measure(index, "hybrid", "candidates", candidates, candidates=candidates)
            measure(index, "hybrid+rerank", "candidates", candidates, candidates=candidates)
        for depth in (5, 10, 20, 30, 50):
            measure(index, "hybrid+rerank", "rerank_candidates", depth, rerank_candidates=depth, candidates=50)
        for k1, b in ((0.9, 0.4), (1.2, 0.5), (1.2, 0.75), (1.5, 0.75), (2.0, 0.75), (1.2, 1.0)):
            measure(index, "keyword", "bm25_k1:b", f"{k1}:{b}", bm25_k1=k1, bm25_b=b)
        for mode in STEMMING_MODES:
            with harness.stemming(mode):
                measure(index, "keyword", "stemming", mode)
                measure(index, "hybrid", "stemming", mode)
    payload["peak_rss_mb"] = harness.peak_rss_mb()
    _write(args.out, payload)
    return 0


# --------------------------------------------------------------------------- calibrate


def _rates(records: list[dict[str, Any]], rule: Any) -> dict[str, float]:
    """Per group: share of queries the rule would present as confident."""
    groups: dict[str, list[bool]] = {}
    for record in records:
        groups.setdefault(record["group"], []).append(bool(rule(record)))
    return {group: round(sum(flags) / len(flags), 4) for group, flags in groups.items()}


def _balanced(rates: dict[str, float], answerable: set[str]) -> float:
    """Mean of (kept answerable) and (refused unanswerable), each macro-averaged over its groups."""
    kept = [rate for group, rate in rates.items() if group in answerable]
    refused = [1 - rate for group, rate in rates.items() if group not in answerable]
    return round((sum(kept) / len(kept) + sum(refused) / len(refused)) / 2, 4)


def cmd_calibrate(args: argparse.Namespace) -> int:
    embedder, bare_reranker, embedding_info, reranker_info = _load_models(args, need_reranker=True)
    reranker = harness.CachingReranker(bare_reranker) if bare_reranker is not None else None
    mini = load_corpus("mini", cache_dir=args.cache_dir)
    scifact = load_corpus("scifact", cache_dir=args.cache_dir, max_queries=args.max_queries)
    mini_index = harness.build_eval_index(mini, embedder, args.cache_dir / "index")
    scifact_index = harness.build_eval_index(scifact, embedder, args.cache_dir / "index")

    mini_answerable = [q for q in mini.queries if q.answerable]
    # "Source removed": the same questions with their answer document filtered out. The remaining
    # documents are on neighbouring topics, which makes these the hardest unanswerable queries.
    # The two API versions answer each other's questions, so those queries are left out.
    removable = [q for q in mini_answerable if not any(d.startswith("api-orders") for d in q.relevant_documents)]
    without_source = {
        q.query_id: [mini_index.document_ids[d.doc_id] for d in mini.documents if d.doc_id not in q.relevant_documents]
        for q in removable
    }
    plan: list[tuple[str, bool, harness.EvalIndex, list[EvalQuery], dict[str, list[str]] | None]] = [
        ("mini: answerable", True, mini_index, mini_answerable, None),
        ("scifact: answerable", True, scifact_index, list(scifact.queries), None),
        ("mini: out-of-scope queries", False, mini_index, [q for q in mini.queries if not q.answerable], None),
        ("mini: source document removed", False, mini_index, removable, without_source),
        ("mini corpus, scifact queries", False, mini_index, list(scifact.queries), None),
        ("scifact corpus, mini queries", False, scifact_index, list(mini.queries), None),
    ]
    answerable_groups = {group for group, answerable, *_ in plan if answerable}

    records: dict[str, list[dict[str, Any]]] = {"hybrid": [], "hybrid+rerank": []}
    for group, answerable, index, queries, document_filter in plan:
        for run in records:
            config = RunConfig.named(run)
            if config.rerank and reranker is None:
                continue
            params = harness.params_for(index, config, top_k=index.settings.search_top_k)
            outcomes = harness.run_queries(index, queries, params, embedder, reranker, document_filter=document_filter)
            records[run].extend(
                {"group": group, "answerable": answerable, **harness.confidence_record(o)} for o in outcomes
            )
            _log(f"calibrate {group} / {run}: {len(outcomes)} queries")

    def table(run: str, thresholds: list[float], signal: str, with_coverage: bool) -> list[dict[str, Any]]:
        out = []
        for threshold in thresholds:
            def rule(record: dict[str, Any], threshold: float = threshold) -> bool:
                value = record[signal]
                covered = with_coverage and record["keyword_coverage"] >= FULL_KEYWORD_COVERAGE
                return covered or (value is not None and value >= threshold)

            rates = _rates(records[run], rule)
            out.append({"threshold": threshold, "confident_share": rates,
                        "balanced_accuracy": _balanced(rates, answerable_groups)})
        return out

    similarity_grid = [round(0.40 + 0.02 * i, 2) for i in range(21)]
    rerank_grid = [round(-8 + 0.5 * i, 1) for i in range(29)]
    tables = {
        "no_rerank: similarity >= t": table("hybrid", similarity_grid, "best_similarity", False),
        "no_rerank: similarity >= t OR full keyword coverage": table("hybrid", similarity_grid, "best_similarity", True),
    }
    if records["hybrid+rerank"]:
        tables["rerank: score >= t"] = table("hybrid+rerank", rerank_grid, "best_rerank", False)
        tables["rerank: score >= t OR full keyword coverage"] = table("hybrid+rerank", rerank_grid, "best_rerank", True)
    payload = _header() | {
        "embedding": embedding_info,
        "reranker": reranker_info,
        "top_k": mini_index.settings.search_top_k,
        "answerable_groups": sorted(answerable_groups),
        "tables": tables,
        "best": {name: max(rows, key=lambda r: r["balanced_accuracy"]) for name, rows in tables.items()},
        "records": records,
    }
    _write(args.out, payload)
    for name, row in payload["best"].items():
        _log(f"{name}: best t={row['threshold']} balanced={row['balanced_accuracy']} {row['confident_share']}")
    return 0


# --------------------------------------------------------------------------- report


def build_report(inputs: list[dict[str, Any]]) -> EvalReport:
    """The app-facing report: one entry per (model configuration, dataset)."""
    datasets = []
    for result in inputs:
        for entry in result["datasets"]:
            datasets.append(
                EvalDataset(
                    name=f"{entry['name']} · {result['label']}",
                    description=entry["description"],
                    documents=entry["documents"],
                    chunks=entry["chunks"],
                    queries=entry["queries"],
                    embedding_version=result["embedding"]["version"],
                    reranker=result["reranker"]["spec"] if result["reranker"] else None,
                    indexing_chunks_per_second=entry["indexing_chunks_per_second"],
                    runs=[
                        EvalRun(
                            name=run["name"],
                            recall_at_k=run["recall_at_k"],
                            precision_at_k=run["precision_at_k"],
                            mrr=run["mrr"],
                            ndcg_at_10=run["ndcg_at_10"],
                            latency_ms_p50=run["latency_ms_p50"],
                            latency_ms_p95=run["latency_ms_p95"],
                        )
                        for run in entry["runs"]
                    ],
                )
            )
    first = inputs[0]
    return EvalReport(
        generated_at=max(datetime.fromisoformat(r["generated_at"]) for r in inputs),
        git_commit=first["git_commit"],
        hardware=first["hardware"],
        command=" && ".join(r["command"] for r in inputs),
        datasets=datasets,
    )


def cmd_report(args: argparse.Namespace) -> int:
    inputs = [json.loads(path.read_text(encoding="utf-8")) for path in args.inputs]
    report = build_report(inputs)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
    _log(f"wrote {args.out}")
    return 0


# --------------------------------------------------------------------------- CLI


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m passageport.evaluation.run", description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)

    def common(sub: argparse.ArgumentParser) -> None:
        sub.add_argument("--embedding", default=DEFAULT_EMBEDDING, help="backend:model (default: %(default)s)")
        sub.add_argument("--reranker", default=DEFAULT_RERANKER, help="backend:model or 'none'")
        sub.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR,
                         help="downloads and scratch indexes (default: <repo>/eval/.cache)")
        sub.add_argument("--model-cache", type=Path, default=None, help="model download directory")
        sub.add_argument("--max-queries", type=int, default=None, help="use only the first N SciFact queries")
        sub.add_argument("--out", type=Path, required=True)

    evaluate = commands.add_parser("evaluate", help="headline metrics for one model configuration")
    common(evaluate)
    evaluate.add_argument("--datasets", nargs="+", choices=DATASET_NAMES, default=list(DATASET_NAMES))
    evaluate.add_argument("--runs", nargs="+", choices=harness.RUN_NAMES, default=list(DEFAULT_RUNS))
    evaluate.add_argument("--label", default="default models")
    evaluate.add_argument("--chunk-tokens", type=int, default=None)
    evaluate.add_argument("--candidates", type=int, default=None)
    evaluate.add_argument("--rrf-k", type=int, default=None)
    evaluate.add_argument("--lexical-weight", type=float, default=None)
    evaluate.add_argument("--vector-weight", type=float, default=None)
    evaluate.add_argument("--rerank-candidates", type=int, default=None)
    evaluate.add_argument("--rebuild", action="store_true", help="ignore a cached scratch index")
    evaluate.set_defaults(handler=cmd_evaluate)

    sweep = commands.add_parser("sweep", help="vary chunk size, fusion, BM25 and tokenizer settings")
    common(sweep)
    sweep.add_argument("--datasets", nargs="+", choices=DATASET_NAMES, default=list(DATASET_NAMES))
    sweep.add_argument("--chunk-sizes", nargs="+", type=int, default=[128, 256, 512])
    sweep.set_defaults(handler=cmd_sweep)

    calibrate = commands.add_parser("calibrate", help="confidence-threshold calibration data")
    common(calibrate)
    calibrate.set_defaults(handler=cmd_calibrate)

    report = commands.add_parser("report", help="merge evaluate outputs into the app-facing report")
    report.add_argument("--inputs", nargs="+", type=Path, required=True)
    report.add_argument("--out", type=Path, required=True)
    report.set_defaults(handler=cmd_report)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    return int(args.handler(args))


if __name__ == "__main__":
    raise SystemExit(main())
