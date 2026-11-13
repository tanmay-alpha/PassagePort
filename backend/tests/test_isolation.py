"""Cross-user isolation: one user's ids must look exactly like ids that do not exist."""

from __future__ import annotations

import pytest
from conftest import SAMPLE_PAGES, Accounts, build_pdf, create_collection, upload_file
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from passageport.db.schema import chunks, collections, documents, pages, sessions

MISSING = "0" * 32
ID_PARAMETERS = ("{collection_id}", "{document_id}", "{chunk_id}", "{token_id}")

# Every route of the collections/documents/auth routers that addresses a resource by id, with
# the request body it needs. ``test_every_id_route_is_covered`` fails when a route is added
# without being listed here.
REQUESTS: dict[tuple[str, str], dict] = {
    ("GET", "/api/collections/{collection_id}"): {},
    ("PATCH", "/api/collections/{collection_id}"): {"json": {"name": "Hijacked"}},
    ("DELETE", "/api/collections/{collection_id}"): {},
    ("GET", "/api/collections/{collection_id}/documents"): {},
    ("POST", "/api/collections/{collection_id}/documents"): {"files": {"file": ("x.txt", b"intruder")}},
    ("GET", "/api/documents/{document_id}"): {},
    ("PATCH", "/api/documents/{document_id}"): {"json": {"title": "Hijacked"}},
    ("DELETE", "/api/documents/{document_id}"): {},
    ("POST", "/api/documents/{document_id}/reindex"): {},
    ("GET", "/api/documents/{document_id}/file"): {},
    ("GET", "/api/documents/{document_id}/outline"): {},
    ("GET", "/api/documents/{document_id}/pages/{page_number}"): {},
    ("GET", "/api/chunks/{chunk_id}"): {},
    ("DELETE", "/api/auth/tokens/{token_id}"): {},
}
OWNED_TAGS = {"collections", "documents", "auth"}


@pytest.fixture
def world(accounts: Accounts) -> dict:
    """Alice owns a collection with an indexed document and an API token; Bob owns nothing."""
    alice = accounts.signup("alice")
    collection_id = create_collection(alice, "Alice's research")
    document = upload_file(alice, collection_id, "biology.pdf", build_pdf(SAMPLE_PAGES)).json()["document"]
    accounts.index_all()
    with accounts.app.state.engine.connect() as conn:
        chunk_id = conn.execute(select(chunks.c.id).order_by(chunks.c.ordinal)).scalars().first()
    token_id = alice.post("/api/auth/tokens", json={"name": "alice-ci"}).json()["id"]
    return {
        "accounts": accounts,
        "alice": alice,
        "bob": accounts.signup("bob"),
        "ids": {
            "collection_id": collection_id,
            "document_id": document["id"],
            "chunk_id": chunk_id,
            "token_id": token_id,
            "page_number": "1",
        },
    }


def _snapshot(accounts: Accounts) -> dict:
    with accounts.app.state.engine.connect() as conn:
        return {
            "collections": conn.execute(
                select(collections.c.id, collections.c.name, collections.c.index_version)
            ).all(),
            "documents": conn.execute(select(documents.c.id, documents.c.title, documents.c.status)).all(),
            "pages": conn.execute(select(func.count()).select_from(pages)).scalar_one(),
            "chunks": conn.execute(select(func.count()).select_from(chunks)).scalar_one(),
            "tokens": conn.execute(
                select(func.count()).select_from(sessions).where(sessions.c.kind == "api")
            ).scalar_one(),
        }


def test_every_id_route_is_covered(accounts):
    routed = {
        (method.upper(), path)
        for path, operations in accounts.app.openapi()["paths"].items()
        for method, operation in operations.items()
        if OWNED_TAGS & set(operation.get("tags", [])) and any(p in path for p in ID_PARAMETERS)
    }
    assert routed == set(REQUESTS)


@pytest.mark.parametrize(("method", "path"), sorted(REQUESTS))
def test_other_users_ids_answer_like_missing_ids(world, method, path):
    accounts, alice, bob, ids = world["accounts"], world["alice"], world["bob"], world["ids"]
    before = _snapshot(accounts)
    kwargs = REQUESTS[(method, path)]

    # Sanity: the request is well-formed, i.e. it works for the owner (checked on a GET only, so
    # the owner's data is not modified before the comparison below).
    if method == "GET":
        assert alice.request(method, path.format(**ids), **kwargs).status_code == 200

    foreign = bob.request(method, path.format(**ids), **kwargs)
    missing = bob.request(
        method,
        path.format(
            **{**ids, **dict.fromkeys(("collection_id", "document_id", "chunk_id", "token_id"), MISSING)}
        ),
        **kwargs,
    )

    assert foreign.status_code == 404, foreign.text
    assert foreign.json()["error"]["code"] == "not_found"
    # Same status, same body: nothing reveals that the id exists for someone else.
    assert (foreign.status_code, foreign.json()) == (missing.status_code, missing.json())
    assert _snapshot(accounts) == before


def test_owner_can_still_use_everything_after_the_attempts(world):
    alice, bob, ids = world["alice"], world["bob"], world["ids"]
    for (method, path), kwargs in REQUESTS.items():
        bob.request(method, path.format(**ids), **kwargs)

    assert alice.get(f"/api/collections/{ids['collection_id']}").json()["name"] == "Alice's research"
    document = alice.get(f"/api/documents/{ids['document_id']}").json()
    assert (document["title"], document["status"]) == ("biology", "indexed")
    assert alice.get(f"/api/documents/{ids['document_id']}/file").content.startswith(b"%PDF-")
    assert alice.get(f"/api/chunks/{ids['chunk_id']}").status_code == 200
    assert len(alice.get("/api/auth/tokens").json()) == 1


def test_lists_and_usage_only_show_own_data(world):
    alice, bob = world["alice"], world["bob"]
    assert bob.get("/api/collections").json() == []
    assert bob.get("/api/auth/tokens").json() == []
    system = bob.get("/api/system").json()
    assert system["usage"] == {"collections": 0, "documents": 0, "chunks": 0, "storage_bytes": 0}
    assert system["pending_jobs"] == 0

    upload_file(alice, world["ids"]["collection_id"], "pending.txt", b"alice's queued upload")
    assert alice.get("/api/system").json()["pending_jobs"] == 1
    assert bob.get("/api/system").json()["pending_jobs"] == 0
    assert alice.get("/api/system").json()["usage"]["documents"] == 2


def test_names_and_content_do_not_collide_across_users(world):
    alice, bob, ids = world["alice"], world["bob"], world["ids"]
    # Bob may reuse Alice's collection name ...
    response = bob.post("/api/collections", json={"name": "Alice's research"})
    assert response.status_code == 201
    bobs_collection = response.json()["id"]
    assert bobs_collection != ids["collection_id"]

    # ... and uploading the very same file is not reported as a duplicate of Alice's document.
    uploaded = upload_file(bob, bobs_collection, "biology.pdf", build_pdf(SAMPLE_PAGES))
    assert uploaded.status_code == 201
    assert uploaded.json()["duplicate"] is False
    assert uploaded.json()["document"]["id"] != ids["document_id"]
    world["accounts"].index_all()

    assert [d["id"] for d in bob.get(f"/api/collections/{bobs_collection}/documents").json()] == [
        uploaded.json()["document"]["id"]
    ]
    assert len(alice.get(f"/api/collections/{ids['collection_id']}/documents").json()) == 1

    # Deleting Bob's copy leaves Alice's file and index alone.
    assert bob.delete(f"/api/collections/{bobs_collection}").status_code == 204
    assert alice.get(f"/api/documents/{ids['document_id']}/file").status_code == 200
    assert alice.get(f"/api/chunks/{ids['chunk_id']}").status_code == 200


def test_quota_is_counted_per_user(make_accounts):
    accounts = make_accounts(max_documents_per_user=1)
    alice, bob = accounts.signup("alice"), accounts.signup("bob")
    assert upload_file(alice, create_collection(alice), "a.txt", b"alice").status_code == 201
    assert upload_file(bob, create_collection(bob), "b.txt", b"bob").status_code == 201
    assert (
        upload_file(bob, bob.get("/api/collections").json()[0]["id"], "c.txt", b"bob again").status_code
        == 409
    )


def test_api_token_is_scoped_to_its_owner(world):
    bob, ids = world["bob"], world["ids"]
    token = bob.post("/api/auth/tokens", json={"name": "bob-ci"}).json()["token"]
    script = TestClient(world["accounts"].app, headers={"Authorization": f"Bearer {token}"})
    assert script.get("/api/collections").json() == []
    assert script.get(f"/api/documents/{ids['document_id']}").status_code == 404
    assert script.delete(f"/api/collections/{ids['collection_id']}").status_code == 404
