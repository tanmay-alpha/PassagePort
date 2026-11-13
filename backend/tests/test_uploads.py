"""Upload validation: size, type sniffing, zip bombs, file names, quotas and de-duplication."""

from __future__ import annotations

import io
import zipfile

import pytest
from conftest import CSRF_HEADERS, build_docx, build_pdf, burst, create_collection, upload_file
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from passageport.db.schema import documents, jobs
from passageport.errors import ApiError
from passageport.storage import validate
from passageport.storage.validate import sanitize_filename, validate_upload


def _error(response) -> dict:
    body = response.json()
    assert set(body) == {"error"} and set(body["error"]) == {"code", "message"}
    return body["error"]


def _stored_blobs(settings) -> list:
    return [p for p in (settings.data_dir / "blobs").rglob("*") if p.is_file()]


def _zip(entries: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return buffer.getvalue()


# --------------------------------------------------------------------------- accepted


@pytest.mark.parametrize(
    ("name", "data", "kind"),
    [
        ("paper.PDF", build_pdf(["text"]), "pdf"),
        ("notes.txt", "naïve café".encode(), "txt"),
        ("bom.txt", b"\xef\xbb\xbfwith a byte order mark", "txt"),
        ("readme.md", b"# Title\n\nbody", "md"),
        ("report.docx", build_docx([("p", "hello")]), "docx"),
    ],
)
def test_supported_files_are_accepted(client, collection_id, name, data, kind):
    response = upload_file(client, collection_id, name, data)
    assert response.status_code == 201, response.text
    document = response.json()["document"]
    assert document["kind"] == kind
    assert document["size_bytes"] == len(data)
    assert document["filename"] == name


# --------------------------------------------------------------------------- rejected by type


@pytest.mark.parametrize(
    ("name", "data"),
    [
        ("malware.exe", b"MZ\x90\x00"),
        ("archive.zip", _zip({"a.txt": b"a"})),
        ("page.html", b"<html></html>"),
        ("noextension", b"plain text"),
        ("legacy.doc", b"\xd0\xcf\x11\xe0 old word"),
        ("double.pdf.exe", build_pdf(["x"])),
        (".pdf", build_pdf(["x"])),
        ("data.bin", b"data"),
    ],
)
def test_extension_allowlist(client, collection_id, settings, name, data):
    response = client.post(
        f"/api/collections/{collection_id}/documents", files={"file": (name, data, "application/pdf")}
    )
    assert response.status_code == 415, response.text
    assert _error(response)["code"] == "unsupported_file"
    assert "PDF, DOCX, TXT or Markdown" in _error(response)["message"]
    assert _stored_blobs(settings) == []


@pytest.mark.parametrize(
    ("name", "data", "fragment"),
    [
        ("fake.pdf", b"<html>not a pdf</html>", "not a PDF"),
        ("late.pdf", b"junk before %PDF-1.7", "not a PDF"),
        ("text.docx", b"just some text", "not a Word document"),
        ("other.docx", _zip({"mimetype": b"application/epub+zip"}), "not a Word document"),
        ("binary.txt", b"abc\x00def", "binary data"),
        ("latin1.txt", "caf\xe9".encode("latin-1"), "UTF-8"),
        ("utf16.md", "# title".encode("utf-16"), "binary data"),
        ("image.md", b"\x89PNG\r\n\x1a\n\xff\xfe", "UTF-8"),
    ],
)
def test_content_must_match_the_extension(client, collection_id, settings, name, data, fragment):
    response = upload_file(client, collection_id, name, data)
    assert response.status_code == 415, response.text
    error = _error(response)
    assert error["code"] == "unsupported_file"
    assert fragment in error["message"]
    assert _stored_blobs(settings) == []


def test_zip_bomb_is_rejected_from_the_central_directory(client, collection_id, settings, monkeypatch):
    """200 MB of zeros compress to ~200 kB. The declared sizes alone must be enough to refuse."""
    bomb = _zip({"word/document.xml": b"<w:document/>", "word/media/bomb.bin": b"\x00" * (200 * 1024 * 1024)})
    assert len(bomb) < 1024 * 1024

    def no_reading(*_args, **_kwargs):
        raise AssertionError("the archive must not be decompressed during validation")

    monkeypatch.setattr(zipfile.ZipFile, "open", no_reading)
    monkeypatch.setattr(zipfile.ZipFile, "read", no_reading)
    response = upload_file(client, collection_id, "bomb.docx", bomb)

    assert response.status_code == 415
    assert "unreasonable size" in _error(response)["message"]
    assert _stored_blobs(settings) == []


def test_zip_with_too_many_entries_is_rejected(monkeypatch):
    monkeypatch.setattr(validate, "MAX_ZIP_ENTRIES", 10)
    crowded = _zip({"word/document.xml": b"<w:document/>"} | {f"f{i}": b"" for i in range(20)})
    with pytest.raises(ApiError) as caught:
        validate_upload("crowded.docx", crowded)
    assert caught.value.status_code == 415


def test_archive_with_a_huge_entry_count_is_refused_before_it_is_opened(monkeypatch):
    """Memory amplification: 30,000 empty entries are a ~3 MB upload but would become 30,000
    Python objects the moment a zip parser opens the archive. It must never get that far."""
    crowded = _zip({"word/document.xml": b"<w:document/>"} | {f"e{i}": b"" for i in range(30_000)})
    assert len(crowded) < 5 * 1024 * 1024

    def never(*_args, **_kwargs):
        raise AssertionError("the archive must not be opened")

    monkeypatch.setattr(validate.zipfile, "ZipFile", never)
    with pytest.raises(ApiError) as caught:
        validate_upload("crowded.docx", crowded)
    assert caught.value.status_code == 415
    assert "unreasonable size" in caught.value.message


def test_entry_count_guard_does_not_trust_the_archive_header(monkeypatch):
    """The end-of-central-directory record claims a single entry; the directory holds 5,000."""
    crowded = bytearray(_zip({"word/document.xml": b"<w:document/>"} | {f"e{i}": b"" for i in range(5_000)}))
    end = crowded.rfind(b"PK\x05\x06")
    crowded[end + 8 : end + 12] = (1).to_bytes(2, "little") * 2  # entries on disk, entries total
    monkeypatch.setattr(validate.zipfile, "ZipFile", lambda *_a, **_k: pytest.fail("opened"))
    with pytest.raises(ApiError) as caught:
        validate_upload("lying.docx", bytes(crowded))
    assert caught.value.status_code == 415


def test_ordinary_documents_pass_the_entry_count_guard():
    assert validate_upload("fine.docx", build_docx([("p", "hello")])).kind == "docx"


# --------------------------------------------------------------------------- size


def test_empty_file_is_rejected(client, collection_id):
    response = upload_file(client, collection_id, "empty.txt", b"")
    assert response.status_code == 422
    assert _error(response) == {"code": "invalid_request", "message": "The file is empty."}


def test_missing_file_field_is_a_validation_error(client, collection_id):
    response = client.post(f"/api/collections/{collection_id}/documents", data={"other": "x"})
    assert response.status_code == 422
    assert _error(response)["code"] == "invalid_request"


def test_oversize_upload_is_rejected(make_settings, make_app):
    settings = make_settings(max_upload_mb=0.01)  # ~10 kB
    with TestClient(make_app(settings), headers=CSRF_HEADERS) as client:
        collection = create_collection(client)
        accepted = upload_file(client, collection, "small.txt", b"a" * 10_000)
        assert accepted.status_code == 201

        # Just over the limit: within the multipart allowance, so the bounded read rejects it.
        over = upload_file(client, collection, "big.txt", b"b" * 11_000)
        assert over.status_code == 413
        assert _error(over)["code"] == "payload_too_large"
        assert "0.01 MB" in _error(over)["message"]

        # Far over the limit: refused from Content-Length before the body is parsed at all.
        huge = upload_file(client, collection, "huge.txt", b"c" * (2 * 1024 * 1024))
        assert huge.status_code == 413
        assert _error(huge)["code"] == "payload_too_large"

        assert len(client.get(f"/api/collections/{collection}/documents").json()) == 1
        assert len(_stored_blobs(settings)) == 1


def test_read_limited_stops_reading_past_the_limit():
    class Endless(io.RawIOBase):
        served = 0

        def read(self, size: int = -1) -> bytes:
            self.served += size
            return b"x" * size

    stream = Endless()
    with pytest.raises(ApiError) as caught:
        validate.read_limited(stream, 3 * 1024 * 1024)
    assert caught.value.status_code == 413
    assert stream.served <= 5 * 1024 * 1024


# --------------------------------------------------------------------------- file names


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("../../etc/passwd.txt", "passwd.txt"),
        ("..\\..\\windows\\system32\\evil.md", "evil.md"),
        ("C:\\Users\\me\\Desktop\\plan.pdf", "plan.pdf"),
        ("/abs/path/report.docx", "report.docx"),
        ("nul\x00byte\r\n.txt", "nulbyte .txt"),
        ("tab\tand  spaces.txt", "tab and spaces.txt"),
        ("rtl\u202etxt.exe.pdf", "rtltxt.exe.pdf"),
        ("trailing.txt. . ", "trailing.txt"),
        ("....//....//x.txt", "x.txt"),
        ("ünïcödé 文档.md", "ünïcödé 文档.md"),
        (None, ""),
        ("", ""),
        ("..", ""),
        ("dir/", ""),
    ],
)
def test_sanitize_filename(raw, expected):
    assert sanitize_filename(raw) == expected


def test_long_filenames_are_capped_but_keep_their_extension():
    name = sanitize_filename("a" * 500 + ".PDF")
    assert len(name) == validate.MAX_FILENAME_CHARS
    assert name.endswith(".PDF")


def test_traversal_filenames_never_reach_the_filesystem(client, collection_id, settings):
    names = ["../../../outside.txt", "..\\..\\outside.txt", "/etc/cron.d/outside.txt", "C:\\outside.txt"]
    for index, name in enumerate(names):
        response = upload_file(client, collection_id, name, f"payload {index}".encode())
        assert response.status_code == 201, response.text
        document = response.json()["document"]
        assert document["filename"] == "outside.txt"
        assert document["title"] == "outside"

    data_dir = settings.data_dir.resolve()
    assert not list(data_dir.parent.rglob("outside*"))
    blobs = _stored_blobs(settings)
    assert len(blobs) == len(names)
    for blob in blobs:
        assert blob.resolve().is_relative_to(data_dir / "blobs")
        assert len(blob.name) == 32 and int(blob.name, 16) >= 0  # server-generated key


# --------------------------------------------------------------------------- duplicates and quotas


def test_duplicate_upload_returns_the_existing_document(client, collection_id, engine, settings):
    data = b"the same bytes"
    first = upload_file(client, collection_id, "one.txt", data)
    second = upload_file(client, collection_id, "renamed-copy.txt", data)

    assert first.status_code == 201 and first.json()["duplicate"] is False
    assert second.status_code == 200 and second.json()["duplicate"] is True
    assert second.json()["document"]["id"] == first.json()["document"]["id"]
    assert second.json()["document"]["filename"] == "one.txt"
    with engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(documents)).scalar_one() == 1
        assert conn.execute(select(func.count()).select_from(jobs)).scalar_one() == 1
    assert len(_stored_blobs(settings)) == 1


def test_same_bytes_in_another_collection_are_a_new_document(client, collection_id):
    other = create_collection(client, "Other")
    first = upload_file(client, collection_id, "a.txt", b"shared")
    second = upload_file(client, other, "a.txt", b"shared")
    assert second.status_code == 201
    assert second.json()["document"]["id"] != first.json()["document"]["id"]


def test_document_count_quota(make_settings, make_app):
    settings = make_settings(max_documents_per_user=2)
    with TestClient(make_app(settings), headers=CSRF_HEADERS) as client:
        collection = create_collection(client)
        assert upload_file(client, collection, "1.txt", b"one").status_code == 201
        assert upload_file(client, collection, "2.txt", b"two").status_code == 201

        blocked = upload_file(client, collection, "3.txt", b"three")
        assert blocked.status_code == 409
        assert _error(blocked)["code"] == "quota_exceeded"
        assert "2 documents" in _error(blocked)["message"]
        assert len(_stored_blobs(settings)) == 2
        # A duplicate stores nothing, so it is still answered when the quota is used up.
        assert upload_file(client, collection, "again.txt", b"one").status_code == 200

        first = client.get(f"/api/collections/{collection}/documents").json()[0]["id"]
        assert client.delete(f"/api/documents/{first}").status_code == 204
        assert upload_file(client, collection, "3.txt", b"three").status_code == 201


def test_storage_quota(make_settings, make_app):
    settings = make_settings(max_storage_mb_per_user=1)
    with TestClient(make_app(settings), headers=CSRF_HEADERS) as client:
        collection = create_collection(client)
        assert upload_file(client, collection, "a.txt", b"a" * 700_000).status_code == 201
        blocked = upload_file(client, collection, "b.txt", b"b" * 700_000)
        assert blocked.status_code == 409
        assert _error(blocked)["code"] == "quota_exceeded"
        assert "1 MB storage limit" in _error(blocked)["message"]
        assert upload_file(client, collection, "c.txt", b"c" * 300_000).status_code == 201
        assert client.get("/api/system").json()["usage"]["storage_bytes"] == 1_000_000


def test_upload_to_unknown_collection_is_404_and_stores_nothing(client, settings):
    response = upload_file(client, "does-not-exist", "a.txt", b"data")
    assert response.status_code == 404
    assert _error(response) == {"code": "not_found", "message": "Collection not found."}
    assert _stored_blobs(settings) == []


def test_concurrent_uploads_cannot_exceed_the_document_quota(make_settings, make_app):
    """Check-then-insert race: ten simultaneous uploads with room for three."""
    settings = make_settings(max_documents_per_user=3)
    app = make_app(settings)
    with TestClient(app, headers=CSRF_HEADERS) as client:
        collection = create_collection(client)

        def send(index: int) -> int:
            own = TestClient(app, headers=CSRF_HEADERS)
            return upload_file(own, collection, f"{index}.txt", f"file {index}".encode()).status_code

        statuses = burst(10, send)

        assert sorted(statuses) == [201] * 3 + [409] * 7, statuses
        assert len(client.get(f"/api/collections/{collection}/documents").json()) == 3
        assert client.get("/api/system").json()["usage"]["documents"] == 3
    assert len(_stored_blobs(settings)) == 3


def test_concurrent_identical_uploads_store_one_document(client, collection_id, settings, app):
    def send(_index: int) -> int:
        return upload_file(
            TestClient(app, headers=CSRF_HEADERS), collection_id, "same.txt", b"same"
        ).status_code

    statuses = burst(8, send)
    assert sorted(statuses) == [200] * 7 + [201], statuses
    assert len(_stored_blobs(settings)) == 1
