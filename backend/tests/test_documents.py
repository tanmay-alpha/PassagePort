"""Document lifecycle through the HTTP API: upload, index, read, rename, re-index, delete."""

from __future__ import annotations

import io

from conftest import SAMPLE_PAGES, build_docx, build_pdf, create_collection, upload_file
from pypdf import PdfReader
from sqlalchemy import func, select

from passageport.api.routes.documents import embedding_is_current
from passageport.chunking import chunker_version
from passageport.db.schema import chunks, collections, documents, jobs, pages
from passageport.ml.registry import get_embedder, models_loaded
from passageport.storage.blobs import get_blob_store


def _count(engine, table, *where) -> int:
    with engine.connect() as conn:
        return conn.execute(select(func.count()).select_from(table).where(*where)).scalar_one()


def _chunk_rows(engine, document_id: str):
    with engine.connect() as conn:
        return conn.execute(
            select(chunks).where(chunks.c.document_id == document_id).order_by(chunks.c.ordinal)
        ).all()


def test_upload_returns_uploaded_document_then_indexes(client, collection_id, index_all, settings):
    response = upload_file(client, collection_id, "biology.pdf", build_pdf(SAMPLE_PAGES))
    assert response.status_code == 201
    body = response.json()
    assert body["duplicate"] is False
    document = body["document"]
    assert document["status"] == "uploaded"
    assert document["title"] == "biology"
    assert document["filename"] == "biology.pdf"
    assert document["kind"] == "pdf"
    assert document["locator_kind"] == "page"
    assert document["chunk_count"] == 0
    assert document["stale"] is False
    assert client.get("/api/system").json()["pending_jobs"] == 1

    assert index_all() == 1

    indexed = client.get(f"/api/documents/{document['id']}").json()
    assert indexed["status"] == "indexed"
    assert indexed["error"] is None
    assert indexed["page_count"] == 3
    assert indexed["chunk_count"] >= 3
    assert indexed["indexed_at"] is not None
    assert indexed["stale"] is False
    assert client.get("/api/system").json()["pending_jobs"] == 0


def test_chunk_pages_match_the_real_pdf_pages(client, engine, indexed_pdf):
    """A citation's page number must be the page a PDF viewer shows for that text."""
    original = client.get(f"/api/documents/{indexed_pdf['id']}/file").content
    reader = PdfReader(io.BytesIO(original))
    real_pages = [" ".join((page.extract_text() or "").split()) for page in reader.pages]

    rows = _chunk_rows(engine, indexed_pdf["id"])
    assert {row.page_number for row in rows} == {1, 2, 3}
    for row in rows:
        assert " ".join(row.text.split()) in real_pages[row.page_number - 1]
        page = client.get(f"/api/documents/{indexed_pdf['id']}/pages/{row.page_number}").json()
        assert page["text"][row.char_start : row.char_end] == row.text
        assert page["page_label"] == f"Page {row.page_number}"
        assert page["page_count"] == 3


def test_empty_pdf_pages_keep_their_numbers(client, collection_id, index_all, engine):
    data = build_pdf(["First page has words.", "", "Third page has words too."])
    document = upload_file(client, collection_id, "gaps.pdf", data).json()["document"]
    index_all()

    outline = client.get(f"/api/documents/{document['id']}/outline").json()
    assert outline["locator_kind"] == "page"
    assert [item["page_number"] for item in outline["items"]] == [1, 2, 3]
    assert client.get(f"/api/documents/{document['id']}/pages/2").json()["text"] == ""
    assert {row.page_number for row in _chunk_rows(engine, document["id"])} == {1, 3}


def test_chunk_endpoint_resolves_a_citation(client, engine, indexed_pdf):
    row = _chunk_rows(engine, indexed_pdf["id"])[0]
    response = client.get(f"/api/chunks/{row.id}")
    assert response.status_code == 200
    passage = response.json()
    assert passage == {
        "chunk_id": row.id,
        "document_id": indexed_pdf["id"],
        "document_title": "biology",
        "document_kind": "pdf",
        "locator_kind": "page",
        "page_number": row.page_number,
        "page_label": f"Page {row.page_number}",
        "char_start": row.char_start,
        "char_end": row.char_end,
        "text": row.text,
    }
    assert client.get("/api/chunks/000000000000000000000000").status_code == 404


def test_markdown_and_docx_use_section_locators(client, collection_id, index_all):
    markdown = b"Intro text.\n\n# Setup\n\nInstall it.\n\n## Usage\n\nRun it.\n"
    md = upload_file(client, collection_id, "guide.md", markdown).json()["document"]
    docx = upload_file(
        client,
        collection_id,
        "report.docx",
        build_docx([("h1", "Findings"), ("p", "Revenue grew."), ("h2", "Risks"), ("p", "Churn rose.")]),
    ).json()["document"]
    assert index_all() == 2

    md_outline = client.get(f"/api/documents/{md['id']}/outline").json()
    assert md_outline["locator_kind"] == "section"
    assert [item["page_label"] for item in md_outline["items"]] == ["guide", "Setup", "Usage"]

    docx_outline = client.get(f"/api/documents/{docx['id']}/outline").json()
    assert [item["page_label"] for item in docx_outline["items"]] == ["Findings", "Risks"]
    section = client.get(f"/api/documents/{docx['id']}/pages/2").json()
    assert section["page_label"] == "Risks"
    assert "Churn rose." in section["text"]


def test_list_filters_by_status_and_query(client, collection_id, index_all):
    first = upload_file(client, collection_id, "Alpha Report.txt", b"alpha content").json()["document"]
    index_all()
    second = upload_file(client, collection_id, "beta-notes.md", b"# Beta\n\nbeta content").json()["document"]

    listing = client.get(f"/api/collections/{collection_id}/documents").json()
    assert [d["id"] for d in listing] == [second["id"], first["id"]]  # newest first

    def ids(**params) -> list[str]:
        response = client.get(f"/api/collections/{collection_id}/documents", params=params)
        assert response.status_code == 200
        return [d["id"] for d in response.json()]

    assert ids(status="indexed") == [first["id"]]
    assert ids(status="uploaded") == [second["id"]]
    assert ids(status="failed") == []
    assert ids(q="ALPHA") == [first["id"]]
    assert ids(q="notes") == [second["id"]]  # matches the file name
    assert ids(q="100%") == []  # LIKE wildcards are literals
    assert ids(q="_") == []
    assert ids(status="") == [second["id"], first["id"]]

    bad = client.get(f"/api/collections/{collection_id}/documents", params={"status": "bogus"})
    assert bad.status_code == 422
    assert bad.json()["error"]["code"] == "invalid_request"


def test_rename_updates_title_and_invalidates_cached_indexes(client, engine, indexed_pdf):
    with engine.connect() as conn:
        before = conn.execute(select(collections.c.index_version)).scalar_one()

    response = client.patch(
        f"/api/documents/{indexed_pdf['id']}", json={"title": "  Cell biology\x00 notes "}
    )
    assert response.status_code == 200
    assert response.json()["title"] == "Cell biology notes"
    assert response.json()["filename"] == "biology.pdf"

    chunk = _chunk_rows(engine, indexed_pdf["id"])[0]
    assert client.get(f"/api/chunks/{chunk.id}").json()["document_title"] == "Cell biology notes"
    with engine.connect() as conn:
        assert conn.execute(select(collections.c.index_version)).scalar_one() == before + 1

    assert client.patch(f"/api/documents/{indexed_pdf['id']}", json={"title": ""}).status_code == 422
    assert client.patch(f"/api/documents/{indexed_pdf['id']}", json={"title": "\x00\x01"}).status_code == 422
    assert client.patch("/api/documents/missing", json={"title": "x"}).status_code == 404


def test_delete_document_leaves_nothing_behind(client, engine, settings, indexed_pdf):
    document_id = indexed_pdf["id"]
    with engine.connect() as conn:
        blob_key = conn.execute(select(documents.c.blob_key)).scalar_one()
        version = conn.execute(select(collections.c.index_version)).scalar_one()
    store = get_blob_store(settings, engine)
    assert store.exists(blob_key)
    chunk_id = _chunk_rows(engine, document_id)[0].id

    assert client.delete(f"/api/documents/{document_id}").status_code == 204

    assert _count(engine, documents) == 0
    assert _count(engine, pages) == 0
    assert _count(engine, chunks) == 0
    assert _count(engine, jobs) == 0
    assert not store.exists(blob_key)
    with engine.connect() as conn:
        assert conn.execute(select(collections.c.index_version)).scalar_one() == version + 1
    for path in ("", "/file", "/outline", "/pages/1"):
        assert client.get(f"/api/documents/{document_id}{path}").status_code == 404
    assert client.get(f"/api/chunks/{chunk_id}").status_code == 404
    assert client.delete(f"/api/documents/{document_id}").status_code == 404
    collection = client.get("/api/collections").json()[0]
    assert (collection["document_count"], collection["chunk_count"], collection["size_bytes"]) == (0, 0, 0)


def test_delete_collection_removes_documents_chunks_and_blobs(client, engine, settings, index_all):
    doomed = create_collection(client, "Doomed")
    kept = create_collection(client, "Kept")
    upload_file(client, doomed, "a.txt", b"alpha text")
    upload_file(client, doomed, "b.txt", b"beta text")
    survivor = upload_file(client, kept, "c.txt", b"gamma text").json()["document"]
    index_all()
    store = get_blob_store(settings, engine)
    with engine.connect() as conn:
        doomed_keys = list(
            conn.execute(select(documents.c.blob_key).where(documents.c.collection_id == doomed)).scalars()
        )
    assert len(doomed_keys) == 2 and all(store.exists(key) for key in doomed_keys)

    assert client.delete(f"/api/collections/{doomed}").status_code == 204

    assert not any(store.exists(key) for key in doomed_keys)
    assert _count(engine, documents) == 1
    assert _count(engine, chunks, chunks.c.collection_id == doomed) == 0
    assert _count(engine, chunks) == survivor_chunks(client, survivor["id"])
    assert _count(engine, pages) == 1
    assert client.get(f"/api/collections/{doomed}").status_code == 404
    assert client.get(f"/api/documents/{survivor['id']}/file").content == b"gamma text"


def survivor_chunks(client, document_id: str) -> int:
    return client.get(f"/api/documents/{document_id}").json()["chunk_count"]


def test_page_endpoint_bounds(client, indexed_pdf):
    base = f"/api/documents/{indexed_pdf['id']}/pages"
    assert client.get(f"{base}/3").status_code == 200
    assert client.get(f"{base}/4").status_code == 404
    assert client.get(f"{base}/0").status_code == 422
    assert client.get(f"{base}/abc").status_code == 422
    assert client.get(f"{base}/99999999999999999999999").status_code == 422


def test_pages_are_not_available_before_indexing(client, collection_id):
    document = upload_file(client, collection_id, "notes.txt", b"some notes").json()["document"]
    assert client.get(f"/api/documents/{document['id']}/outline").json()["items"] == []
    assert client.get(f"/api/documents/{document['id']}/pages/1").status_code == 404


def test_file_download_is_sandboxed(client, collection_id, indexed_pdf):
    response = client.get(f"/api/documents/{indexed_pdf['id']}/file")
    assert response.status_code == 200
    assert response.content.startswith(b"%PDF-")
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-security-policy"] == "sandbox; default-src 'none'"
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["content-disposition"].startswith('inline; filename="biology.pdf"')

    # The declared upload type is ignored; HTML-looking text comes back as a plain-text download.
    html = b"<script>alert(1)</script>"
    sent = client.post(
        f"/api/collections/{collection_id}/documents", files={"file": ("page.txt", html, "text/html")}
    )
    text = client.get(f"/api/documents/{sent.json()['document']['id']}/file")
    assert text.content == html
    assert text.headers["content-type"] == "text/plain; charset=utf-8"
    assert text.headers["content-disposition"].startswith("attachment;")


def test_download_filename_is_rfc5987_encoded(client, collection_id):
    name = "résumé; v2 final.txt"
    document = upload_file(client, collection_id, name, b"cv").json()["document"]
    assert document["filename"] == name
    disposition = client.get(f"/api/documents/{document['id']}/file").headers["content-disposition"]
    assert disposition == (
        "attachment; filename=\"r_sum__ v2 final.txt\"; filename*=UTF-8''r%C3%A9sum%C3%A9%3B%20v2%20final.txt"
    )


def test_stale_flag_follows_embedder_and_chunker_versions(
    client, engine, settings, indexed_pdf, make_settings
):
    version = get_embedder().version
    assert embedding_is_current(settings, version)
    assert not embedding_is_current(settings, "fastembed:other-model:384")
    assert not embedding_is_current(settings, None)

    with engine.begin() as conn:
        conn.execute(documents.update().values(embedding_version="fastembed:BAAI/bge-small-en-v1.5:384"))
    assert client.get(f"/api/documents/{indexed_pdf['id']}").json()["stale"] is True

    with engine.begin() as conn:
        conn.execute(documents.update().values(embedding_version=version, chunker_version="old-chunker"))
    assert client.get(f"/api/documents/{indexed_pdf['id']}").json()["stale"] is True

    with engine.begin() as conn:
        conn.execute(documents.update().values(chunker_version=chunker_version(settings)))
    assert client.get(f"/api/documents/{indexed_pdf['id']}").json()["stale"] is False


def test_stale_check_does_not_load_a_real_model(make_settings):
    """With a real backend configured but not loaded, only ``backend:model`` is compared - the
    check must never construct (download) the model."""
    settings = make_settings(embedding_backend="fastembed", embedding_model="BAAI/bge-small-en-v1.5")
    assert embedding_is_current(settings, "fastembed:BAAI/bge-small-en-v1.5:384")
    assert not embedding_is_current(settings, "fastembed:BAAI/bge-base-en-v1.5:768")
    assert not embedding_is_current(settings, "hashing:feature-hashing:256")
    assert models_loaded()["embedder"] is False
