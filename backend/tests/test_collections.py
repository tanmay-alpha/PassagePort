"""Collection CRUD and aggregate counts."""

from __future__ import annotations

from conftest import CSRF_HEADERS, burst, create_collection, upload_file
from fastapi.testclient import TestClient
from sqlalchemy import event

from passageport.db import repos


def test_create_get_and_list_sorted_by_name(client):
    ids = {name: create_collection(client, name) for name in ("zebra", "Alpha", "mango")}

    listing = client.get("/api/collections").json()
    assert [c["name"] for c in listing] == ["Alpha", "mango", "zebra"]

    one = client.get(f"/api/collections/{ids['mango']}").json()
    assert one == {
        "id": ids["mango"],
        "name": "mango",
        "description": "",
        "created_at": one["created_at"],
        "updated_at": one["updated_at"],
        "document_count": 0,
        "indexed_count": 0,
        "processing_count": 0,
        "failed_count": 0,
        "chunk_count": 0,
        "size_bytes": 0,
    }
    assert one["created_at"].endswith(("Z", "+00:00"))  # ISO-8601 UTC


def test_create_validates_and_cleans_input(client):
    created = client.post(
        "/api/collections", json={"name": "  Quarterly\x00  reports ", "description": " a\n b "}
    )
    assert created.status_code == 201
    assert created.json()["name"] == "Quarterly reports"
    assert created.json()["description"] == "a b"

    for body in (
        {"name": ""},
        {"name": "   "},
        {"name": "x" * 121},
        {"name": "ok", "description": "d" * 501},
        {},
    ):
        response = client.post("/api/collections", json=body)
        assert response.status_code == 422, body
        assert response.json()["error"]["code"] == "invalid_request"
    unknown_field = client.post("/api/collections", json={"name": "ok", "owner_id": "someone-else"})
    assert unknown_field.status_code == 422


def test_duplicate_name_is_a_conflict(client):
    create_collection(client, "Research")
    again = client.post("/api/collections", json={"name": "Research"})
    assert again.status_code == 409
    assert again.json() == {
        "error": {"code": "conflict", "message": "A collection with this name already exists."}
    }
    assert len(client.get("/api/collections").json()) == 1


def test_patch_renames_and_updates_description(client):
    first = create_collection(client, "First")
    create_collection(client, "Second")

    renamed = client.patch(f"/api/collections/{first}", json={"name": "Primary"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Primary"

    described = client.patch(f"/api/collections/{first}", json={"description": "Main workspace"})
    assert described.json()["name"] == "Primary"
    assert described.json()["description"] == "Main workspace"
    assert described.json()["updated_at"] >= renamed.json()["updated_at"]

    assert client.patch(f"/api/collections/{first}", json={"name": "Primary"}).status_code == 200  # no-op
    assert client.patch(f"/api/collections/{first}", json={"name": "Second"}).status_code == 409
    assert client.patch(f"/api/collections/{first}", json={"name": ""}).status_code == 422
    assert client.patch("/api/collections/missing", json={"name": "x"}).status_code == 404


def test_missing_collection_is_404(client):
    for method, path in (
        ("GET", "/api/collections/nope"),
        ("DELETE", "/api/collections/nope"),
        ("GET", "/api/collections/nope/documents"),
    ):
        response = client.request(method, path)
        assert response.status_code == 404
        assert response.json() == {"error": {"code": "not_found", "message": "Collection not found."}}


def test_counts_reflect_document_states(client, index_all, engine):
    busy = create_collection(client, "Busy")
    empty = create_collection(client, "Empty")
    upload_file(client, busy, "good.txt", b"readable text " * 50)
    upload_file(client, busy, "bad.pdf", b"%PDF-1.7 broken beyond repair")
    index_all()
    upload_file(client, busy, "pending.md", b"# waiting\n\nnot indexed yet")

    by_id = {c["id"]: c for c in client.get("/api/collections").json()}
    counts = by_id[busy]
    assert counts["document_count"] == 3
    assert counts["indexed_count"] == 1
    assert counts["failed_count"] == 1
    assert counts["processing_count"] == 1
    assert counts["chunk_count"] >= 1
    assert counts["size_bytes"] == sum(
        d["size_bytes"] for d in client.get(f"/api/collections/{busy}/documents").json()
    )
    assert counts["chunk_count"] == sum(
        d["chunk_count"] for d in client.get(f"/api/collections/{busy}/documents").json()
    )
    assert by_id[empty]["document_count"] == 0 and by_id[empty]["chunk_count"] == 0

    usage = client.get("/api/system").json()["usage"]
    assert usage == {
        "collections": 2,
        "documents": 3,
        "chunks": counts["chunk_count"],
        "storage_bytes": counts["size_bytes"],
    }


def test_listing_collections_is_one_query_regardless_of_size(client, engine, index_all):
    for index in range(6):
        collection = create_collection(client, f"Collection {index}")
        upload_file(client, collection, f"doc{index}.txt", f"content {index}".encode())
    index_all()

    statements: list[str] = []

    def record(_conn, _cursor, statement, *_rest):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        with engine.connect() as conn:
            user_id = conn.exec_driver_sql("SELECT id FROM users").scalar_one()
            statements.clear()
            rows = repos.list_collections(conn, user_id)
    finally:
        event.remove(engine, "before_cursor_execute", record)

    assert len(rows) == 6
    assert len(statements) == 1
    assert all(row.document_count == 1 and row.indexed_count == 1 for row in rows)


def test_collection_quota(make_settings, make_app):
    app = make_app(make_settings(max_collections_per_user=2))
    with TestClient(app, headers=CSRF_HEADERS) as client:
        first = create_collection(client, "One")
        create_collection(client, "Two")

        blocked = client.post("/api/collections", json={"name": "Three"})
        assert blocked.status_code == 409
        assert blocked.json()["error"]["code"] == "quota_exceeded"
        assert "limit of 2 collections" in blocked.json()["error"]["message"]
        assert len(client.get("/api/collections").json()) == 2
        # Renaming is not creating, and deleting frees a slot.
        assert client.patch(f"/api/collections/{first}", json={"name": "Uno"}).status_code == 200
        assert client.delete(f"/api/collections/{first}").status_code == 204
        assert client.post("/api/collections", json={"name": "Three"}).status_code == 201
        # The limit is internal: the API surface is unchanged.
        assert "max_collections" not in client.get("/api/system").text


def test_concurrent_creates_cannot_exceed_the_collection_quota(make_settings, make_app):
    app = make_app(make_settings(max_collections_per_user=2))
    with TestClient(app, headers=CSRF_HEADERS) as client:

        def create(index: int) -> int:
            own = TestClient(app, headers=CSRF_HEADERS)
            return own.post("/api/collections", json={"name": f"Collection {index}"}).status_code

        statuses = burst(8, create)
        assert sorted(statuses) == [201] * 2 + [409] * 6, statuses
        assert len(client.get("/api/collections").json()) == 2


def test_collection_quota_is_per_user(make_accounts):
    accounts = make_accounts(max_collections_per_user=1)
    alice, bob = accounts.signup("alice"), accounts.signup("bob")
    assert alice.post("/api/collections", json={"name": "A"}).status_code == 201
    assert bob.post("/api/collections", json={"name": "B"}).status_code == 201
    assert bob.post("/api/collections", json={"name": "C"}).status_code == 409
