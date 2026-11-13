"""Evaluation corpora.

``mini``     the small hand-written corpus committed under ``eval/datasets/mini`` (chunk-level
             relevance through quoted substrings, plus out-of-scope queries).
``scifact``  BEIR SciFact, test split (document-level relevance). Downloaded on first use into a
             cache directory; never committed.
"""

from __future__ import annotations

import csv
import json
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MINI_DIR = REPO_ROOT / "eval" / "datasets" / "mini"
DEFAULT_CACHE_DIR = REPO_ROOT / "eval" / ".cache"
SCIFACT_URL = "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip"
DATASET_NAMES = ("mini", "scifact")


@dataclass(frozen=True, slots=True)
class EvalDocument:
    doc_id: str
    title: str
    kind: str  # md | txt — parsed by the application's own parser
    data: bytes


@dataclass(frozen=True, slots=True)
class Quote:
    document: str
    quote: str


@dataclass(frozen=True, slots=True)
class EvalQuery:
    query_id: str
    text: str
    kind: str  # paraphrase | exact | out_of_scope | claim
    relevant_documents: frozenset[str]
    quotes: tuple[Quote, ...] = ()

    @property
    def answerable(self) -> bool:
        return bool(self.relevant_documents)


@dataclass(frozen=True, slots=True)
class EvalCorpus:
    name: str
    description: str
    relevance: str  # "chunk": a hit must contain the quoted text; "document": any chunk of the document
    documents: tuple[EvalDocument, ...]
    queries: tuple[EvalQuery, ...]


def load_mini(directory: Path | None = None) -> EvalCorpus:
    directory = directory or DEFAULT_MINI_DIR
    documents = tuple(
        EvalDocument(path.name, path.stem.replace("-", " "), path.suffix.lstrip("."), path.read_bytes())
        for path in sorted((directory / "docs").iterdir())
        if path.suffix in (".md", ".txt")
    )
    names = {d.doc_id for d in documents}
    queries: list[EvalQuery] = []
    for line in (directory / "queries.jsonl").read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        quotes = tuple(Quote(r["document"], r["quote"]) for r in record["relevant"])
        unknown = {q.document for q in quotes} - names
        if unknown:
            raise ValueError(f"query {record['id']} refers to unknown documents: {sorted(unknown)}")
        queries.append(
            EvalQuery(record["id"], record["query"], record["type"], frozenset(q.document for q in quotes), quotes)
        )
    return EvalCorpus(
        name="mini",
        description=(
            "Hand-written technical corpus (operating systems, networking, databases, an API spec in two "
            "versions, operations, security, a research-style report). A hit is relevant when its chunk "
            "contains the labelled quote. Small and self-authored: indicative only."
        ),
        relevance="chunk",
        documents=documents,
        queries=tuple(queries),
    )


def _download_scifact(cache_dir: Path) -> Path:
    target = cache_dir / "datasets" / "scifact"
    if (target / "corpus.jsonl").exists():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    archive = target.parent / "scifact.zip"
    if not archive.exists():
        with urllib.request.urlopen(SCIFACT_URL, timeout=120) as response:  # noqa: S310 - fixed https URL
            archive.write_bytes(response.read())
    with zipfile.ZipFile(archive) as bundle:
        root = target.parent.resolve()
        for member in bundle.namelist():
            if not (root / member).resolve().is_relative_to(root):
                raise ValueError("unexpected path in the SciFact archive")
        bundle.extractall(root)  # noqa: S202 - member paths validated above
    return target


def load_scifact(cache_dir: Path | None = None, max_queries: int | None = None) -> EvalCorpus:
    directory = _download_scifact(cache_dir or DEFAULT_CACHE_DIR)
    documents = []
    with (directory / "corpus.jsonl").open(encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            body = f"{record['title']}\n\n{record['text']}".encode()
            documents.append(EvalDocument(str(record["_id"]), record["title"][:250] or str(record["_id"]), "txt", body))
    relevant: dict[str, set[str]] = {}
    with (directory / "qrels" / "test.tsv").open(encoding="utf-8") as handle:
        for row in csv.DictReader(handle, delimiter="\t"):
            if int(row["score"]) > 0:
                relevant.setdefault(row["query-id"], set()).add(row["corpus-id"])
    queries = []
    with (directory / "queries.jsonl").open(encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            if str(record["_id"]) in relevant:
                queries.append(
                    EvalQuery(str(record["_id"]), record["text"], "claim", frozenset(relevant[str(record["_id"])]))
                )
    queries.sort(key=lambda q: int(q.query_id))
    if max_queries is not None:
        queries = queries[:max_queries]
    return EvalCorpus(
        name="scifact",
        description=(
            "BEIR SciFact, test split: scientific claims as queries against 5,183 paper abstracts. "
            "Relevance is judged per document; a ranking is reduced to its distinct documents."
        ),
        relevance="document",
        documents=tuple(documents),
        queries=tuple(queries),
    )


def load_corpus(name: str, *, cache_dir: Path | None = None, mini_dir: Path | None = None,
                max_queries: int | None = None) -> EvalCorpus:
    if name == "mini":
        return load_mini(mini_dir)
    if name == "scifact":
        return load_scifact(cache_dir, max_queries)
    raise ValueError(f"unknown dataset {name!r}; choose from {DATASET_NAMES}")
