"""Evidence-backed answers.

Order of decisions for a question:

1. Retrieve (hybrid, re-ranked when a re-ranker is available) — the same path as Search.
2. Sufficiency gate: if retrieval is low-confidence, answer ``insufficient`` and still show what
   was found. No model is asked to improvise from weak evidence.
3. No language model configured -> ``extractive``: verbatim sentences with citations.
4. Language model configured -> ``generated``; its citations are validated, and if the call fails
   or the reply cites nothing valid, the answer falls back to extractive with a notice.

``checks`` lists exactly what the server verified and what it did not.
"""

from __future__ import annotations

import time

from sqlalchemy import Connection

from passageport.answer import llm
from passageport.answer.extractive import select_sentences
from passageport.answer.prompt import (
    ANSWER_SYSTEM_PROMPT,
    PromptPassage,
    build_messages,
    has_valid_citation,
    parse_cited_answer,
)
from passageport.api.schemas import AnswerSegment, AskIn, AskOut, Evidence
from passageport.config import Settings
from passageport.domain import User
from passageport.search.service import Retrieval, RetrievalParams, retrieve

CHECK_CITATIONS_RESOLVE = "Every citation points to a retrieved passage"
CHECK_UNCITED_FLAGGED = "Sentences without a valid citation are flagged as unsupported"
CHECK_NOT_FACT_CHECKED = "Generated wording was not independently fact-checked"
CHECK_VERBATIM = "Every sentence is quoted verbatim from the passage it cites"
CHECK_SELECTION_ONLY = (
    "Sentences were selected by similarity to the question; whether they fully answer it was not checked"
)
CHECK_THRESHOLDS = "Retrieved passages were compared against the relevance thresholds and none passed"
CHECK_NO_ANSWER = "No answer was generated"
CHECK_MODEL_DECLINED = (
    "The language model judged the retrieved passages insufficient; its judgement was not checked"
)

NOTICE_EXTRACTIVE = (
    "No language model is configured. These are excerpts quoted from your documents, not a generated answer."
)
NOTICE_INSUFFICIENT = (
    "The documents do not appear to contain an answer to this question. "
    "The closest passages are listed for reference."
)
NOTICE_MODEL_DECLINED = (
    "The language model found that the retrieved passages do not answer this question. "
    "The passages are listed for reference."
)
NOTICE_FALLBACK_FAILED = (
    "The language model could not be reached, so these are excerpts quoted from your documents, "
    "not a generated answer."
)
NOTICE_FALLBACK_UNCITED = (
    "The language model's reply did not cite any retrieved passage and was discarded. "
    "These are excerpts quoted from your documents instead."
)
NOTICE_SOME_UNSUPPORTED = "Some sentences have no supporting citation and are marked as unsupported."


def _ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000.0, 3)


def _extractive(question: str, evidence: list[Evidence], retrieval: Retrieval) -> list[AnswerSegment]:
    return select_sentences(question, [(e.ref, e.text) for e in evidence], retrieval.embedder)


def run_ask(conn: Connection, user: User, body: AskIn, settings: Settings) -> AskOut:
    started = time.perf_counter()
    params = RetrievalParams.from_settings(settings, mode="hybrid", top_k=body.top_k)
    retrieval = retrieve(
        conn,
        user,
        query=body.question,
        collection_id=body.collection_id,
        document_ids=body.document_ids,
        params=params,
        settings=settings,
    )
    evidence = retrieval.evidence()
    timings = {"retrieve": retrieval.timings["total"], "answer": 0.0, "total": 0.0}

    def reply(
        mode: str,
        segments: list[AnswerSegment],
        notice: str | None,
        checks: list[str],
        llm_model: str | None = None,
    ) -> AskOut:
        timings["total"] = _ms(started)
        if evidence and retrieval.partial_notice:
            notice = f"{notice} {retrieval.partial_notice}" if notice else retrieval.partial_notice
        return AskOut(
            question=retrieval.query,
            mode=mode,  # type: ignore[arg-type]
            segments=segments,
            evidence=evidence,
            notice=notice,
            llm_model=llm_model,
            checks=checks,
            timings_ms=timings,
        )

    if retrieval.low_confidence:
        # ``retrieval.notice`` already explains empty collections, pending indexing and so on.
        notice = retrieval.notice if not evidence else NOTICE_INSUFFICIENT
        return reply("insufficient", [], notice, [CHECK_THRESHOLDS, CHECK_NO_ANSWER])

    answer_started = time.perf_counter()
    client = llm.get_client(settings)
    fallback_notice = NOTICE_EXTRACTIVE
    if client is not None:
        prompt_evidence = evidence[: settings.llm_max_evidence]
        messages = build_messages(
            ANSWER_SYSTEM_PROMPT, retrieval.query, [PromptPassage(e.ref, e.text) for e in prompt_evidence]
        )
        text = llm.complete_safely(client, messages)
        if text is None:
            fallback_notice = NOTICE_FALLBACK_FAILED
        else:
            segments = parse_cited_answer(text, {e.ref for e in prompt_evidence})
            timings["answer"] = _ms(answer_started)
            if segments is None:
                return reply(
                    "insufficient",
                    [],
                    NOTICE_MODEL_DECLINED,
                    [CHECK_MODEL_DECLINED, CHECK_NO_ANSWER],
                    client.model,
                )
            if has_valid_citation(segments):
                unsupported = any(not s.supported for s in segments)
                return reply(
                    "generated",
                    segments,
                    NOTICE_SOME_UNSUPPORTED if unsupported else None,
                    [CHECK_CITATIONS_RESOLVE, CHECK_UNCITED_FLAGGED, CHECK_NOT_FACT_CHECKED],
                    client.model,
                )
            fallback_notice = NOTICE_FALLBACK_UNCITED

    segments = _extractive(retrieval.query, evidence, retrieval)
    timings["answer"] = _ms(answer_started)
    return reply("extractive", segments, fallback_notice, [CHECK_VERBATIM, CHECK_SELECTION_ONLY])
