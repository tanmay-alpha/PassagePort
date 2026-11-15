"""Abuse resistance of a public deployment: anonymous account creation, storage exhaustion,
memory and CPU amplification by crafted documents or requests.

Timing assertions use inputs on which the previous, quadratic implementations took tens of
seconds, with thresholds far above what the linear versions need, so a busy machine cannot make
them flaky.
"""

from __future__ import annotations

import random
import re
import threading
import time
from collections.abc import Callable
from datetime import timedelta
from typing import Any

import pytest
from conftest import CSRF_HEADERS, Accounts, burst, create_collection, upload_file
from fastapi.testclient import TestClient
from retrieval_helpers import Workspace
from sqlalchemy import Engine, update

from passageport.answer import sentences
from passageport.answer.sentences import split_sentences
from passageport.api import ratelimit
from passageport.auth import passwords, service
from passageport.chunking import MAX_CHARS_PER_TOKEN, chunk_pages
from passageport.compare.align import diff_passages
from passageport.config import Settings
from passageport.db import repos
from passageport.db.schema import users, utcnow
from passageport.domain import ParsedPage, User
from passageport.errors import ApiError
from passageport.ingest.pipeline import STORAGE_FULL
from passageport.ml.hashing import HashingEmbedder
from passageport.search.index import IndexCache

pytest_plugins = ["retrieval_helpers"]

MB = 1024 * 1024


def _elapsed(call: Callable[[], Any]) -> float:
    started = time.perf_counter()
    call()
    return time.perf_counter() - started


# --------------------------------------------------------------------------- guest accounts


def _guest(accounts: Accounts, host: str = "testclient", **headers: str) -> int:
    client = TestClient(accounts.app, headers={**CSRF_HEADERS, **headers}, client=(host, 50000))
    return client.post("/api/auth/guest").status_code


def test_guest_creation_is_capped_server_wide(make_accounts: Callable[..., Accounts]) -> None:
    """Every guest gets the full per-user quotas, and the per-address throttle does not bound what
    many addresses create together: the number of live guests must be capped globally."""
    accounts = make_accounts(allow_guests=True, max_guests=3, guest_ttl_hours=1)
    statuses = [_guest(accounts, f"198.51.100.{i}") for i in range(5)]
    assert statuses == [200, 200, 200, 429, 429]
    refused = accounts.client().post("/api/auth/guest").json()["error"]
    assert refused["code"] == "rate_limited" and "capacity" in refused["message"]

    # Expired guests no longer count (and are purged), so capacity comes back.
    with accounts.app.state.engine.begin() as conn:
        conn.execute(update(users).values(created_at=utcnow() - timedelta(hours=2)))
    assert _guest(accounts, "198.51.100.200") == 200


def test_concurrent_guest_creation_cannot_overrun_the_cap(make_accounts: Callable[..., Accounts]) -> None:
    accounts = make_accounts(allow_guests=True, max_guests=3)
    statuses = burst(8, lambda i: _guest(accounts, f"203.0.113.{i}"))
    assert sorted(statuses) == [200, 200, 200, 429, 429, 429, 429, 429]


def test_ipv6_clients_are_throttled_per_64(make_accounts: Callable[..., Accounts]) -> None:
    """One IPv6 subscriber controls a whole /64; per-address keys would let it rotate forever."""
    accounts = make_accounts(allow_guests=True)
    statuses = [_guest(accounts, f"2001:db8:0:1::{i:x}") for i in range(1, 12)]
    assert statuses == [200] * 10 + [429]
    assert _guest(accounts, "2001:db8:0:2::1") == 200  # another /64 is another client


def test_forwarded_headers_from_the_client_are_not_trusted(make_accounts: Callable[..., Accounts]) -> None:
    """The app keys throttles on the peer address only. X-Forwarded-For is applied by uvicorn
    ``--proxy-headers`` for trusted proxies (FORWARDED_ALLOW_IPS), never by the app itself."""
    accounts = make_accounts(allow_guests=True)
    statuses = [_guest(accounts, **{"X-Forwarded-For": f"192.0.2.{i}"}) for i in range(11)]
    assert statuses == [200] * 10 + [429]


@pytest.mark.parametrize(
    ("peer", "key"),
    [
        ("192.0.2.7", "192.0.2.7"),
        ("2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"),
        ("2001:DB8:1:2::ffff", "2001:db8:1:2::/64"),
        ("::ffff:192.0.2.7", "192.0.2.7"),
        ("testclient", "testclient"),
    ],
)
def test_client_address_keys(peer: str, key: str) -> None:
    class _Request:
        client = type("Client", (), {"host": peer})()

    assert service.client_address(_Request()) == key  # type: ignore[arg-type]


def test_password_hashing_runs_a_bounded_number_at_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """argon2 allocates 64 MiB per computation; a burst of sign-ins must not multiply that by the
    size of the thread pool."""
    lock = threading.Lock()
    active = peak = 0

    def busy(*_args: object) -> str:
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.05)
        with lock:
            active -= 1
        return "$argon2id$fake"

    class SlowHasher:
        hash = staticmethod(busy)
        verify = staticmethod(busy)

    monkeypatch.setattr(passwords, "_hasher", SlowHasher())
    results = burst(12, lambda i: passwords.verify_password("$argon2id$stored", f"guess {i}"))
    assert results == [True] * 12
    assert peak <= passwords.MAX_CONCURRENT_HASHES


def test_rate_limit_table_forgets_idle_users(monkeypatch: pytest.MonkeyPatch) -> None:
    """A stream of short-lived guests must not grow the per-user table without bound."""
    monkeypatch.setattr(ratelimit, "_MAX_TRACKED_USERS", 5)
    monkeypatch.setattr(ratelimit, "_WINDOW_SECONDS", -1.0)  # every earlier call is already idle
    settings = Settings(rate_limit_per_minute=10)
    for i in range(50):
        ratelimit.rate_limit(User(id=f"user-{i}", username=f"user-{i}"), settings)
    assert len(ratelimit._calls) <= 5


# --------------------------------------------------------------------------- storage ceiling


def _database_size(engine: Engine) -> int:
    with engine.connect() as conn:
        return repos.database_size_bytes(conn)


def _ceiling(make_accounts: Callable[..., Accounts], **overrides: Any) -> Accounts:
    """An app whose PP_MAX_DATABASE_MB leaves between 1 and 2 MB of room in its database."""
    probe = make_accounts(blob_backend="db")
    ceiling = _database_size(probe.app.state.engine) // MB + 2
    return make_accounts(blob_backend="db", max_database_mb=ceiling, **overrides)


def _text(size: int, seed: int) -> bytes:
    words = [f"term{seed}x{i}" for i in range(size // 10)]
    return " ".join(words).encode()[:size]


def test_uploads_stop_at_the_database_ceiling(make_accounts: Callable[..., Accounts]) -> None:
    """Quotas are per user; with open sign-up only a server-wide ceiling keeps a size-limited
    database (a free hosted plan) from being filled."""
    accounts = _ceiling(make_accounts)
    client = accounts.signup("alice")
    collection = create_collection(client)
    assert upload_file(client, collection, "small.txt", _text(300_000, 1)).status_code == 201

    refused = upload_file(client, collection, "large.txt", _text(2_200_000, 2))
    assert refused.status_code == 507
    assert refused.json()["error"]["code"] == "storage_full"
    documents = client.get(f"/api/collections/{collection}/documents").json()
    assert [d["filename"] for d in documents] == ["small.txt"]


def test_indexing_stops_at_the_database_ceiling(make_accounts: Callable[..., Accounts]) -> None:
    """Extracted text and embeddings can be many times the file size (compressed PDFs), so the
    ceiling is checked again right before an index is written."""
    accounts = _ceiling(make_accounts)
    client = accounts.signup("alice")
    collection = create_collection(client)
    uploaded = upload_file(client, collection, "notes.txt", _text(900_000, 3))
    assert uploaded.status_code == 201
    accounts.index_all()
    document = client.get(f"/api/documents/{uploaded.json()['document']['id']}").json()
    assert document["status"] == "failed"
    assert document["error"] == STORAGE_FULL
    assert document["chunk_count"] == 0


def test_no_database_ceiling_by_default(engine: Engine) -> None:
    with engine.connect() as conn:
        assert repos.database_has_room(conn, 0, 10**15)
        assert repos.database_size_bytes(conn) > 0


# --------------------------------------------------------------------------- request bounds


def test_document_filters_are_bounded(client: TestClient, collection_id: str) -> None:
    """An unbounded id list overflowed the SQL driver's parameter limit (a 500)."""
    ids = [f"{i:x}" for i in range(40_000)]
    for path, field in (("/api/search", "query"), ("/api/ask", "question"), ("/api/lab/search", "query")):
        response = client.post(
            path, json={field: "anything", "collection_id": collection_id, "document_ids": ids}
        )
        assert response.status_code == 422, (path, response.text)
        assert response.json()["error"]["code"] == "invalid_request"


def test_index_cache_is_bounded_by_total_chunks(workspace: Workspace) -> None:
    ids = []
    for i in range(3):
        collection_id = workspace.collection(f"C{i}")
        workspace.document(collection_id, "Doc", ["\n".join(f"line {i} number {n}" for n in range(5))])
        ids.append(collection_id)
    version = workspace.embedder.version
    cache = IndexCache(chunk_capacity=8)
    with workspace.engine.connect() as conn:
        for collection_id in ids:
            index, _ = cache.get(conn, collection_id, version)
            assert len(index) == 5
    assert len(cache) == 1 and ids[2] in cache

    # The index being served is kept even when it alone exceeds the budget.
    small = IndexCache(chunk_capacity=3)
    with workspace.engine.connect() as conn:
        small.get(conn, ids[0], version)
    assert ids[0] in small


# --------------------------------------------------------------------------- CPU amplification


def test_chunks_are_capped_in_characters() -> None:
    """WordPiece maps any word over 100 characters to one [UNK] token (the hashing embedder counts
    it as one token too): token counting alone let a crafted page become one huge chunk."""
    settings = Settings(embedding_backend="hashing")
    page = ParsedPage(1, "Page 1", "x" * 50_000 + " closing words here. " + "!" * 20_000)
    drafts = chunk_pages([page], HashingEmbedder(), settings)
    cap = settings.chunk_max_tokens * MAX_CHARS_PER_TOKEN
    assert len(drafts) > 1
    assert max(len(d.text) for d in drafts) <= cap
    assert all(page.text[d.char_start : d.char_end] == d.text for d in drafts)
    # Ordinary prose is far below the cap, so its boundaries are unchanged by it.
    prose = ParsedPage(1, "Page 1", "The quick brown fox jumps over the lazy dog. " * 400)
    assert max(len(d.text) for d in chunk_pages([prose], HashingEmbedder(), settings)) < cap // 2


@pytest.mark.parametrize(
    "text",
    [
        "!" * 60_000,  # sentence punctuation not followed by whitespace
        "a" * 60_000 + " . Next",  # a long word in front of a detached period
        "x. a " * 15_000,  # many boundaries rejected as lowercase continuations
    ],
)
def test_sentence_splitting_is_linear(text: str) -> None:
    assert _elapsed(lambda: split_sentences(text)) < 3.0


_REFERENCE_BOUNDARY = re.compile(r"""[.!?]+["')\]]*(?=\s+\S)""")
_REFERENCE_LAST_WORD = re.compile(r"([^\W\d_][\w.]*)[.!?]+[\"')\]]*$")


def _reference_split(text: str) -> list[sentences.Sentence]:
    """The splitter as it was before the linear rewrite (quadratic, but the reference)."""

    def abbreviation(fragment: str) -> bool:
        match = _REFERENCE_LAST_WORD.search(fragment)
        if not match:
            return False
        word = match.group(1).rstrip(".").lower()
        return word in sentences._ABBREVIATIONS or len(word) == 1 or ("." in word and len(word) <= 4)

    def split_block(found: list[sentences.Sentence], block: str, offset: int) -> None:
        start = 0
        for match in _REFERENCE_BOUNDARY.finditer(block):
            end = match.end()
            if abbreviation(block[start:end]) or block[end:].lstrip()[:1].islower():
                continue
            sentences._append(found, block, start, end, offset)
            start = end
        sentences._append(found, block, start, len(block), offset)

    found: list[sentences.Sentence] = []
    offset = block_start = 0
    for line in text.splitlines(keepends=True):
        if not line.strip() or sentences._STRUCTURAL_LINE.match(line):
            split_block(found, text[block_start:offset], block_start)
            split_block(found, line, offset)
            block_start = offset + len(line)
        offset += len(line)
    split_block(found, text[block_start:], block_start)
    return found


def test_linear_sentence_rules_match_the_original_patterns() -> None:
    """The rewrites must change the running time only, never a sentence boundary."""
    alphabet = "aZé1_.!?\"')] \n\tbxe.gU.S."
    rng = random.Random(20261115)
    for _ in range(20_000):
        text = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 40)))
        assert split_sentences(text) == _reference_split(text), text
        assert [m.span() for m in sentences._BOUNDARY.finditer(text)] == [
            m.span() for m in _REFERENCE_BOUNDARY.finditer(text)
        ], text
        if not text.endswith("\n"):  # "$" also matches before a final newline; fragments never end so
            reference = _REFERENCE_LAST_WORD.search(text)
            expected = reference.group(1).rstrip(".") if reference else None
            assert sentences._last_word(text, 0, len(text)) == expected, text


def test_passage_diff_work_is_bounded() -> None:
    """difflib's ratio() is quadratic on repetitive text: two 20,000-character near-identical
    sentences took close to a minute."""
    long_a, long_b = "a" * 20_000, "a" * 19_999 + "b"
    assert _elapsed(lambda: diff_passages({"a": long_a, "b": long_b})) < 3.0
    many_a = " ".join(f"Point {i} holds." for i in range(1500))
    many_b = " ".join(f"Point {i} held." for i in range(1500))
    assert _elapsed(lambda: diff_passages({"a": many_a, "b": many_b, "c": many_a, "d": many_b})) < 3.0
    # Ordinary passages still get their fuzzy matches.
    diff = diff_passages(
        {
            "a": "The cache holds 512 entries. Requests are retried three times.",
            "b": "The cache holds 1024 entries. Requests are retried three times!",
        }
    )
    assert diff.shared_sentences == ["Requests are retried three times."]
    assert [d.values for d in diff.numeric_differences] == [{"a": "512", "b": "1024"}]


def test_compare_on_crafted_passages_stays_fast(workspace: Workspace) -> None:
    """End to end, including chunks stored before the character cap existed."""
    collection_id = workspace.collection()
    first = workspace.document(collection_id, "One", ["alpha " + "a" * 20_000 + " end."])
    second = workspace.document(collection_id, "Two", ["alpha " + "a" * 20_000 + " end!"])
    payload = {"question": "alpha end", "document_ids": [first, second], "interpret": False}
    started = time.perf_counter()
    body = workspace.ok("/api/compare", payload)
    assert time.perf_counter() - started < 5.0
    assert len(body["alignments"]) == 1


def test_guest_cap_counts_only_guests(make_accounts: Callable[..., Accounts]) -> None:
    accounts = make_accounts(allow_guests=True, max_guests=1)
    accounts.signup("alice")
    assert _guest(accounts) == 200
    with pytest.raises(ApiError) as refused:
        service.create_guest(accounts.app.state.engine, accounts.settings, "192.0.2.1")
    assert refused.value.status_code == 429
