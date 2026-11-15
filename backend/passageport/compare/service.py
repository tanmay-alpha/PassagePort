"""Compare two to four documents on one question.

For every document the question is retrieved *within that document* through the normal search
path, and only passages that pass the relevance rules count as evidence. A document without such a
passage is reported with ``has_evidence=false``; nothing is invented to stand in for it.

Evidence passages of different documents are then aligned by embedding similarity
(``align.match_passages``) and each aligned group is diffed from its text alone
(``align.diff_passages``). The optional language-model interpretation is produced last, kept in its
own field, and its citations are validated exactly like an Ask answer.
"""

from __future__ import annotations

import time

from sqlalchemy import Connection

from passageport.answer import llm
from passageport.answer.prompt import (
    COMPARE_SYSTEM_PROMPT,
    PromptPassage,
    build_messages,
    has_valid_citation,
    parse_cited_answer,
)
from passageport.api.schemas import (
    AlignedPassage,
    Alignment,
    AnswerSegment,
    CompareDocument,
    CompareIn,
    CompareOut,
    Evidence,
    NumericDifference,
)
from passageport.compare.align import AlignItem, diff_passages, match_passages
from passageport.config import Settings
from passageport.db.access import require_documents
from passageport.domain import User
from passageport.errors import ApiError
from passageport.ml import registry
from passageport.search.service import RetrievalParams, clean_query, retrieve

# Minimum cosine similarity for two passages of different documents to be shown side by side.
# Calibrated with the default embedding model (BAAI/bge-small-en-v1.5), whose similarities between
# unrelated technical passages sit well above zero; see docs/SEARCH_EVALUATION.md, "Compare".
ALIGN_MIN_SIMILARITY = 0.8

NOTICE_NO_EVIDENCE = "None of the selected documents contains a passage relevant to this question."
NOTICE_INTERPRETATION = (
    "The interpretation was written by a language model from the cited passages. "
    "Its citations were checked; its wording was not independently fact-checked."
)
NOTICE_INTERPRETATION_FAILED = "The language model could not be reached, so no interpretation is shown."
NOTICE_INTERPRETATION_DISCARDED = (
    "The language model's interpretation did not cite any retrieved passage and was discarded."
)
NOTICE_INTERPRETATION_DECLINED = "The language model found the passages insufficient for an interpretation."


def _ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000.0, 3)


def _quoted(titles: list[str]) -> str:
    return ", ".join(f'"{t}"' for t in titles)


def _require_comparable(rows: list, embedding_version: str) -> None:
    for row in rows:
        if row.status in ("uploaded", "processing"):
            raise ApiError(
                409, "conflict", f'"{row.title}" is still being indexed. Try again when it is ready.'
            )
        if row.status != "indexed":
            raise ApiError(409, "conflict", f'"{row.title}" could not be indexed and cannot be compared.')
        if row.embedding_version != embedding_version:
            raise ApiError(
                409,
                "conflict",
                f'"{row.title}" was indexed with a different embedding model. Re-index it before comparing.',
            )


def _interpret(
    question: str, documents: list[CompareDocument], settings: Settings
) -> tuple[list[AnswerSegment] | None, str | None, str | None]:
    """(segments, model name, notice). Segments are ``None`` whenever nothing trustworthy came back."""
    client = llm.get_client(settings)
    with_evidence = [d for d in documents if d.has_evidence]
    if client is None or len(with_evidence) < 2:
        return None, None, None
    per_document = max(1, -(-settings.llm_max_evidence // len(with_evidence)))
    passages = [
        PromptPassage(e.ref, e.text, source=d.title) for d in with_evidence for e in d.evidence[:per_document]
    ]
    text = llm.complete_safely(client, build_messages(COMPARE_SYSTEM_PROMPT, question, passages))
    if text is None:
        return None, None, NOTICE_INTERPRETATION_FAILED
    segments = parse_cited_answer(text, {p.ref for p in passages})
    if segments is None:
        return None, None, NOTICE_INTERPRETATION_DECLINED
    if not has_valid_citation(segments):
        return None, None, NOTICE_INTERPRETATION_DISCARDED
    return segments, client.model, NOTICE_INTERPRETATION


def run_compare(conn: Connection, user: User, body: CompareIn, settings: Settings) -> CompareOut:
    started = time.perf_counter()
    question = clean_query(body.question, settings)
    if len(set(body.document_ids)) != len(body.document_ids):
        raise ApiError(422, "invalid_request", "Select each document only once.")
    rows = require_documents(conn, user, body.document_ids)
    embedder = registry.get_embedder()
    _require_comparable(rows, embedder.version)

    params = RetrievalParams.from_settings(settings, mode="hybrid", top_k=body.top_k_per_document)
    query_vector = embedder.embed_query(question)
    documents: list[CompareDocument] = []
    items: list[AlignItem] = []
    evidence_by_ref: dict[int, Evidence] = {}
    next_ref = 1
    for row in rows:
        retrieval = retrieve(
            conn,
            user,
            query=question,
            collection_id=row.collection_id,
            document_ids=[row.id],
            params=params,
            settings=settings,
            embedder=embedder,
            query_vector=query_vector,
        )
        relevant = [c for c in retrieval.results if c.relevant]
        evidence = retrieval.evidence(first_ref=next_ref, candidates=relevant)
        next_ref += len(evidence)
        for candidate, entry in zip(relevant, evidence, strict=True):
            items.append(AlignItem(entry.ref, row.id, retrieval.vector(candidate)))
            evidence_by_ref[entry.ref] = entry
        documents.append(
            CompareDocument(
                document_id=row.id, title=row.title, has_evidence=bool(evidence), evidence=evidence
            )
        )
    timings = {"retrieve": _ms(started), "align": 0.0, "interpret": 0.0, "total": 0.0}

    align_started = time.perf_counter()
    groups, unaligned_refs = match_passages(items, ALIGN_MIN_SIMILARITY)
    alignments: list[Alignment] = []
    for group in groups:
        members = [evidence_by_ref[ref] for ref in group.refs]
        diff = diff_passages({m.document_id: m.text for m in members})
        alignments.append(
            Alignment(
                passages=[AlignedPassage(document_id=m.document_id, ref=m.ref) for m in members],
                similarity=round(group.similarity, 4),
                shared_sentences=diff.shared_sentences,
                unique_sentences=diff.unique_sentences,
                numeric_differences=[
                    NumericDifference(context=d.context, values=d.values) for d in diff.numeric_differences
                ],
                identical=diff.identical,
            )
        )
    unaligned = [
        AlignedPassage(document_id=evidence_by_ref[ref].document_id, ref=ref) for ref in unaligned_refs
    ]
    timings["align"] = _ms(align_started)

    notices: list[str] = []
    missing = [d.title for d in documents if not d.has_evidence]
    if len(missing) == len(documents):
        notices.append(NOTICE_NO_EVIDENCE)
    elif missing:
        notices.append(f"No relevant passage was found in {_quoted(missing)}.")

    interpretation: list[AnswerSegment] | None = None
    llm_model: str | None = None
    if body.interpret:
        interpret_started = time.perf_counter()
        interpretation, llm_model, interpretation_notice = _interpret(question, documents, settings)
        if interpretation_notice:
            notices.append(interpretation_notice)
        timings["interpret"] = _ms(interpret_started)

    timings["total"] = _ms(started)
    return CompareOut(
        question=question,
        documents=documents,
        alignments=alignments,
        unaligned=unaligned,
        interpretation=interpretation,
        llm_model=llm_model,
        notice=" ".join(notices) or None,
        timings_ms=timings,
    )
