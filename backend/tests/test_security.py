"""HTTP hardening: host guard, CSRF, headers, CORS, body limits, static files, error hygiene."""

from __future__ import annotations

import os
import re

import pytest
from conftest import CSRF_HEADERS, build_pdf, create_collection, upload_file
from fastapi.testclient import TestClient
from pydantic import ValidationError

from passageport.api import middleware
from passageport.api.static import resolve_static_file
from passageport.config import Settings
from passageport.db import repos

# --------------------------------------------------------------------------- host guard (local mode)


@pytest.mark.parametrize(
    "host", ["localhost", "localhost:8000", "127.0.0.1:5173", "[::1]:8000", "LOCALHOST:8000", "testserver"]
)
def test_local_mode_serves_loopback_hosts(client, host):
    assert client.get("/api/collections", headers={"Host": host}).status_code == 200


@pytest.mark.parametrize(
    "host",
    [
        "evil.example",
        "evil.example:8000",
        "192.168.1.20:8000",
        "localhost.evil.example",
        "127.0.0.1.nip.io",
        "[::2]:8000",
        "localhost@evil.example",
        "",
    ],
)
def test_local_mode_rejects_other_hosts(client, host):
    """DNS rebinding: an attacker's domain resolving to 127.0.0.1 still sends its own Host."""
    for path in ("/api/collections", "/api/health", "/api/session", "/", "/api/docs"):
        response = client.get(path, headers={"Host": host})
        assert response.status_code == 403, (host, path)
        assert response.json()["error"]["code"] == "forbidden"
        assert response.headers["x-content-type-options"] == "nosniff"
    assert client.post("/api/collections", json={"name": "x"}, headers={"Host": host}).status_code == 403


def test_allowed_hosts_are_configurable(make_settings, make_app):
    app = make_app(make_settings(local_allowed_hosts=["notes.lan"]))
    with TestClient(app, headers=CSRF_HEADERS, base_url="http://notes.lan:8000") as client:
        assert client.get("/api/collections").status_code == 200
        assert client.get("/api/collections", headers={"Host": "localhost"}).status_code == 403


def test_accounts_mode_has_no_host_restriction(accounts):
    assert (
        accounts.client().get("/api/health", headers={"Host": "passageport.example.com"}).status_code == 200
    )


def test_hostname_parsing():
    assert middleware.hostname("Example.COM:8443") == "example.com"
    assert middleware.hostname("[::1]:8000") == "[::1]"
    assert middleware.hostname("[::1]") == "[::1]"
    assert middleware.hostname(None) == ""


# --------------------------------------------------------------------------- CSRF


def test_unsafe_methods_require_the_csrf_header(app):
    bare = TestClient(app)
    for method, path in (
        ("POST", "/api/collections"),
        ("PATCH", "/api/collections/x"),
        ("DELETE", "/api/collections/x"),
        ("PUT", "/api/collections/x"),
        ("POST", "/api/documents/x/reindex"),
        ("POST", "/api/auth/login"),
        ("POST", "/api/auth/logout"),
    ):
        response = bare.request(method, path, json={"name": "x"})
        assert response.status_code == 403, path
        assert response.json()["error"]["code"] == "csrf"
    assert bare.get("/api/collections").status_code == 200  # safe methods are unaffected
    assert (
        bare.post("/api/collections", json={"name": "x"}, headers={"X-PassagePort-CSRF": "yes"}).status_code
        == 403
    )
    assert bare.post("/api/collections", json={"name": "x"}, headers=CSRF_HEADERS).status_code == 201


def test_cross_site_form_post_cannot_create_data(client):
    """What a hostile page can actually send: a simple form POST, no custom header."""
    forged = TestClient(client.app).post(
        "/api/collections",
        content=b'{"name": "planted"}',
        headers={"Content-Type": "text/plain", "Origin": "https://evil.example"},
    )
    assert forged.status_code == 403
    assert client.get("/api/collections").json() == []


@pytest.mark.parametrize(
    ("origin", "allowed"),
    [
        ("http://testserver", True),
        ("https://testserver", True),  # TLS terminated by a proxy in front of the app
        ("http://localhost:5173", True),  # local mode: the Vite dev server
        ("http://127.0.0.1:3000", True),
        ("https://evil.example", False),
        ("http://testserver.evil.example", False),
        ("http://evil.example/http://testserver", False),
        ("null", False),
        ("", False),
        ("file://", False),
    ],
)
def test_origin_check_in_local_mode(client, origin, allowed):
    response = client.post("/api/collections", json={"name": f"from {origin}"}, headers={"Origin": origin})
    assert response.status_code == (201 if allowed else 403)
    if not allowed:
        assert response.json()["error"]["code"] == "csrf"


def test_origin_check_in_accounts_mode(make_accounts):
    accounts = make_accounts(cors_origins=["https://app.example.com"])
    client = accounts.signup("alice")

    def post(origin: str) -> int:
        return client.post(
            "/api/collections", json={"name": f"from {origin}"}, headers={"Origin": origin}
        ).status_code

    assert post("http://testserver") == 201
    assert post("https://app.example.com") == 201  # explicitly trusted
    assert post("http://localhost:5173") == 403  # the loopback allowance is for local mode only
    assert post("https://evil.example") == 403


def test_bearer_header_does_not_bypass_csrf_in_local_mode(app):
    bare = TestClient(app, headers={"Authorization": "Bearer pp_anything"})
    response = bare.post("/api/collections", json={"name": "x"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf"


def test_login_requires_the_csrf_header(accounts):
    accounts.signup("alice")
    response = TestClient(accounts.app).post(
        "/api/auth/login", json={"username": "alice", "password": "x" * 12}
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf"


# --------------------------------------------------------------------------- response headers


def _assert_security_headers(response, *, csp: str = middleware.APP_CSP) -> None:
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["x-frame-options"] == "DENY"
    assert "camera=()" in response.headers["permissions-policy"]
    assert response.headers["content-security-policy"] == csp


def test_security_headers_on_every_kind_of_response(client, collection_id, app):
    document = upload_file(client, collection_id, "a.txt", b"text").json()["document"]
    responses = [
        client.get("/api/health"),
        client.get("/api/collections"),
        client.get("/api/collections/missing"),  # ApiError
        client.get("/api/no-such-endpoint"),  # router 404
        client.put("/api/collections"),  # 405
        client.post("/api/collections", json={}),  # validation error
        TestClient(app).post("/api/collections", json={"name": "x"}),  # rejected by middleware
        client.get("/api/health", headers={"Host": "evil.example"}),
        client.delete(f"/api/collections/{create_collection(client, 'temp')}"),  # 204
    ]
    for response in responses:
        _assert_security_headers(response)
        assert response.headers["cache-control"] == "no-store"

    download = client.get(f"/api/documents/{document['id']}/file")
    _assert_security_headers(download, csp="sandbox; default-src 'none'")
    assert download.headers["cache-control"] == "private, no-store"


def test_app_csp_matches_the_documented_policy():
    assert middleware.APP_CSP == (
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; "
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    )


def test_swagger_docs_get_their_own_csp(client):
    docs = client.get("/api/docs")
    assert docs.status_code == 200
    _assert_security_headers(docs, csp=middleware.DOCS_CSP)
    assert "https://cdn.jsdelivr.net" in docs.headers["content-security-policy"]
    # Only that exact page: the schema and everything else keep the strict policy.
    _assert_security_headers(client.get("/api/openapi.json"))
    for script in re.findall(r'<script[^>]+src="([^"]+)"', docs.text):
        assert script.startswith("https://cdn.jsdelivr.net/")


def test_hsts_only_with_secure_cookies_in_accounts_mode(client, make_accounts):
    assert "strict-transport-security" not in client.get("/api/health").headers
    insecure = make_accounts(cookie_secure=False).client()
    assert "strict-transport-security" not in insecure.get("/api/health").headers


# --------------------------------------------------------------------------- CORS


def _preflight(client, origin: str):
    return client.options(
        "/api/collections",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-passageport-csrf",
        },
    )


def test_no_cors_headers_unless_configured(client):
    preflight = _preflight(client, "https://app.example.com")
    assert "access-control-allow-origin" not in preflight.headers
    simple = client.get("/api/health", headers={"Origin": "https://app.example.com"})
    assert "access-control-allow-origin" not in simple.headers


def test_cors_is_limited_to_configured_origins(make_accounts):
    accounts = make_accounts(cors_origins=["https://app.example.com", "*"])
    client = accounts.client()

    allowed = _preflight(client, "https://app.example.com")
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "https://app.example.com"
    assert allowed.headers["access-control-allow-credentials"] == "true"
    assert "x-passageport-csrf" in allowed.headers["access-control-allow-headers"].lower()

    # The wildcard entry is dropped: credentials are never offered to arbitrary origins.
    for origin in ("https://evil.example", "https://app.example.com.evil.example", "null"):
        denied = _preflight(client, origin)
        assert denied.headers.get("access-control-allow-origin") not in (origin, "*")
        simple = client.get("/api/health", headers={"Origin": origin})
        assert "access-control-allow-origin" not in simple.headers


# --------------------------------------------------------------------------- request bodies


def test_json_bodies_are_bounded(client):
    response = client.post(
        "/api/collections", json={"name": "x", "description": "d" * (middleware.MAX_BODY_BYTES + 1)}
    )
    assert response.status_code == 413
    assert response.json() == {"error": {"code": "payload_too_large", "message": "The request is too large."}}


def test_bodies_without_content_length_are_counted(client):
    def chunks():
        for _ in range(40):
            yield b" " * 64 * 1024  # 2.5 MB in total, sent with chunked transfer encoding

    response = client.post("/api/collections", content=chunks(), headers={"Content-Type": "application/json"})
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"
    assert client.get("/api/collections").json() == []


def test_malformed_json_is_a_clean_validation_error(client):
    response = client.post(
        "/api/collections", content=b'{"name": ', headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


# --------------------------------------------------------------------------- unknown routes


def test_unknown_api_paths_are_json_404(client):
    for method in ("GET", "POST", "DELETE"):
        response = client.request(method, "/api/does/not/exist")
        assert response.status_code == 404
        assert response.json() == {"error": {"code": "not_found", "message": "Not found."}}
    wrong_method = client.put("/api/collections")
    assert wrong_method.status_code == 405
    assert wrong_method.json() == {"error": {"code": "invalid_request", "message": "Method not allowed."}}


def test_nul_bytes_in_the_url_are_rejected_early(client, collection_id):
    for url in ("/api/documents/abc%00def", f"/api/collections/{collection_id}/documents?q=a%00b"):
        response = client.get(url)
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "invalid_request"


# --------------------------------------------------------------------------- static frontend


@pytest.fixture
def site(tmp_path, make_settings, make_app):
    """A built frontend next to a file that must never be reachable through it."""
    (tmp_path / "secret.txt").write_text("TOP SECRET")
    root = tmp_path / "dist"
    (root / "assets" / "pdfjs" / "wasm").mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html><title>PassagePort</title><div id=root></div>")
    (root / "favicon.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
    (root / "theme-init.js").write_text("document.documentElement.dataset.theme='dark'")
    (root / "assets" / "index-C3x9aQ1b.js").write_text("console.log('app')")
    (root / "assets" / "index-Dk2LmN8p.css").write_text("body{margin:0}")
    (root / "assets" / "pdfjs" / "pdf.worker.min.mjs").write_text("export {}")
    (root / "assets" / "pdfjs" / "wasm" / "openjpeg.wasm").write_bytes(b"\x00asm\x01\x00\x00\x00")
    (root / ".env").write_text("PP_LLM_API_KEY=TOP SECRET")
    with TestClient(make_app(make_settings(static_dir=root)), headers=CSRF_HEADERS) as client:
        yield client, root


def test_static_files_are_served_with_correct_types_and_caching(site):
    client, _root = site
    expected = {
        "/favicon.svg": ("image/svg+xml", "public, max-age=3600"),
        "/theme-init.js": ("text/javascript; charset=utf-8", "public, max-age=3600"),
        "/assets/index-C3x9aQ1b.js": (
            "text/javascript; charset=utf-8",
            "public, max-age=31536000, immutable",
        ),
        "/assets/index-Dk2LmN8p.css": ("text/css; charset=utf-8", "public, max-age=31536000, immutable"),
        "/assets/pdfjs/pdf.worker.min.mjs": ("text/javascript; charset=utf-8", "public, max-age=3600"),
        "/assets/pdfjs/wasm/openjpeg.wasm": ("application/wasm", "public, max-age=3600"),
    }
    for path, (content_type, cache) in expected.items():
        response = client.get(path)
        assert response.status_code == 200, path
        assert response.headers["content-type"] == content_type, path
        assert response.headers["cache-control"] == cache, path
        _assert_security_headers(response)
    assert client.head("/assets/index-C3x9aQ1b.js").status_code == 200


def test_spa_routes_fall_back_to_index_html(site):
    client, _root = site
    for path in ("/", "/login", "/c/abc123/search", "/d/abc123", "/settings", "/index.html"):
        response = client.get(path)
        assert response.status_code == 200, path
        assert "<title>PassagePort</title>" in response.text
        assert response.headers["content-type"] == "text/html; charset=utf-8"
        assert response.headers["cache-control"] == "no-cache"
        _assert_security_headers(response)


def test_missing_assets_and_api_paths_never_fall_back_to_html(site):
    client, _root = site
    missing_asset = client.get("/assets/index-gone1234.js")
    assert missing_asset.status_code == 404
    assert missing_asset.json()["error"]["code"] == "not_found"

    for path in ("/api", "/api/", "/api/nope", "/api/collections/x/unknown"):
        response = client.get(path)
        assert response.status_code == 404, path
        assert response.headers["content-type"] == "application/json"
        assert response.json()["error"]["code"] == "not_found"
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.post("/login", json={}).status_code == 405


@pytest.mark.parametrize(
    "path",
    [
        "/%2e%2e/secret.txt",
        "/%2e%2e%2fsecret.txt",
        "/..%2fsecret.txt",
        "/assets/%2e%2e/%2e%2e/secret.txt",
        "/assets/..%2f..%2fsecret.txt",
        "/..%5csecret.txt",
        "/assets/..%5c..%5csecret.txt",
        "/%2e%2e%5csecret.txt",
        "//secret.txt",
        "/.env",
        "/assets/../.env",
        "/assets/%2e%2e/.env",
        "/....//secret.txt",
        "/assets/pdfjs/../../../secret.txt",
    ],
)
def test_static_path_traversal_is_blocked(site, path):
    client, _root = site
    response = client.get(path)
    assert "TOP SECRET" not in response.text
    assert response.status_code in (200, 404)
    if response.status_code == 200:
        assert "<title>PassagePort</title>" in response.text  # the SPA shell, nothing else


def test_resolve_static_file_rejects_everything_outside_the_root(tmp_path):
    root = (tmp_path / "dist").resolve()
    (root / "assets").mkdir(parents=True)
    (root / "assets" / "app.js").write_text("ok")
    (root / ".hidden").write_text("no")
    (tmp_path / "secret.txt").write_text("TOP SECRET")

    assert resolve_static_file(root, "assets/app.js") == root / "assets" / "app.js"
    for path in (
        "",
        "../secret.txt",
        "assets/../../secret.txt",
        "..\\secret.txt",
        "assets\\app.js",
        "/etc/passwd",
        str(tmp_path / "secret.txt"),
        "C:/Windows/win.ini",
        "assets//app.js",
        "./assets/app.js",
        ".hidden",
        "assets/.",
        "assets",
        "assets/app.js\x00.png",
        "assets/missing.js",
        "nul",
    ):
        assert resolve_static_file(root, path) is None, path


def test_symlinks_cannot_lead_out_of_the_static_root(tmp_path):
    root = (tmp_path / "dist").resolve()
    root.mkdir()
    (tmp_path / "secret.txt").write_text("TOP SECRET")
    try:
        os.symlink(tmp_path / "secret.txt", root / "innocent.txt")
    except (OSError, NotImplementedError):
        pytest.skip("symlinks are not available on this platform/account")
    assert resolve_static_file(root, "innocent.txt") is None


def test_without_a_static_dir_the_root_is_a_json_404(client):
    response = client.get("/")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


# --------------------------------------------------------------------------- error hygiene


_PATH_PATTERNS = re.compile(
    r"[A-Za-z]:\\|\\\\|/home/|/tmp/|/usr/|/var/|site-packages|\.py\b|Traceback|sqlalchemy|sqlite", re.I
)


def _assert_clean_error(response, tmp_path) -> None:
    body = response.json()
    assert set(body) == {"error"} and set(body["error"]) == {"code", "message"}
    text = response.text
    assert not _PATH_PATTERNS.search(text), text
    assert str(tmp_path) not in text and tmp_path.name not in text
    assert str(tmp_path).replace("\\", "\\\\") not in text


def test_error_bodies_never_contain_paths_or_internals(
    client, collection_id, index_all, tmp_path, settings, engine
):
    broken = upload_file(client, collection_id, "broken.pdf", b"%PDF-1.7 definitely not valid").json()[
        "document"
    ]
    locked = upload_file(client, collection_id, "locked.pdf", build_pdf(["x"], encrypt="pw")).json()[
        "document"
    ]
    gone = upload_file(client, collection_id, "gone.txt", b"file removed from disk").json()["document"]
    for blob in (settings.data_dir / "blobs").rglob("*"):
        if blob.is_file() and blob.read_bytes() == b"file removed from disk":
            blob.unlink()
    index_all()

    for document in (broken, locked, gone):
        failed = client.get(f"/api/documents/{document['id']}").json()
        assert failed["status"] == "failed"
        assert not _PATH_PATTERNS.search(failed["error"]), failed["error"]
        assert tmp_path.name not in failed["error"]

    errors = [
        client.get(f"/api/documents/{gone['id']}/file"),  # blob missing on disk
        client.get("/api/documents/../../etc/passwd"),
        client.get("/api/collections/..%2f..%2fetc%2fpasswd"),
        client.get(f"/api/documents/{broken['id']}/pages/1"),
        upload_file(client, collection_id, "..\\..\\evil.exe", b"MZ"),
        upload_file(client, collection_id, "fake.docx", b"not a zip"),
        upload_file(client, collection_id, "empty.txt", b""),
        client.post("/api/collections", json={"name": 5}),
        client.post("/api/collections", content=b"\xff\xfe", headers={"Content-Type": "application/json"}),
        client.patch(f"/api/documents/{broken['id']}", json={}),
        client.get("/api/chunks/" + "x" * 5000),
    ]
    for response in errors:
        assert response.status_code >= 400, response.url
        _assert_clean_error(response, tmp_path)


@pytest.mark.parametrize("log_level", ["WARNING", "DEBUG"])
def test_unhandled_exceptions_are_generic_500s(app, tmp_path, monkeypatch, caplog, log_level):
    app.state.settings.log_level = log_level

    def explode(*_args, **_kwargs):
        raise RuntimeError(f"cannot open {tmp_path / 'data' / 'passageport.db'}: secret detail")

    monkeypatch.setattr(repos, "list_collections", explode)
    with caplog.at_level("ERROR", logger="passageport"):
        response = TestClient(app, raise_server_exceptions=False).get("/api/collections")

    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": "internal_error", "message": "Something went wrong on the server."}
    }
    _assert_clean_error(response, tmp_path)
    assert "RuntimeError" in caplog.text
    assert "secret detail" not in caplog.text


def test_system_endpoint_reveals_no_secrets_or_paths(make_settings, make_app, tmp_path):
    settings = make_settings(
        llm_base_url="https://llm.internal.example/v1",
        llm_api_key="sk-super-secret-key",
        llm_model="gpt-test",
        signup_code="invite-only-code",
    )
    with TestClient(make_app(settings), headers=CSRF_HEADERS) as client:
        response = client.get("/api/system")
    assert response.status_code == 200
    body = response.json()
    assert body["llm_configured"] is True and body["llm_model"] == "gpt-test"
    assert body["embedding"] == {
        "backend": "hashing",
        "model": "feature-hashing",
        "dimensions": 256,
        "loaded": True,
        "enabled": True,
    }
    assert body["reranker"] == {
        "backend": "none",
        "model": "",
        "dimensions": None,
        "loaded": False,
        "enabled": False,
    }
    assert body["limits"]["allowed_extensions"] == [".pdf", ".txt", ".md", ".docx"]
    assert body["limits"]["max_upload_bytes"] == 25 * 1024 * 1024
    assert body["search_defaults"]["rerank"] is False
    for secret in (
        "sk-super-secret-key",
        "llm.internal.example",
        "invite-only-code",
        "passageport.db",
        tmp_path.name,
    ):
        assert secret not in response.text


def test_health_reveals_nothing_and_needs_no_session(accounts):
    response = accounts.client().get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.parametrize("field", ["embed_batch_size", "job_lease_seconds", "job_max_attempts"])
@pytest.mark.parametrize("value", [0, -1])
def test_nonpositive_worker_settings_fail_before_the_server_starts(field, value):
    with pytest.raises(ValidationError) as caught:
        Settings(**{field: value})
    assert caught.value.errors()[0]["loc"] == (field,)


def test_worker_and_collection_defaults_are_usable():
    settings = Settings()
    assert settings.max_collections_per_user == 100
    assert settings.embed_batch_size > 0
    assert settings.job_lease_seconds > 0
    assert settings.job_max_attempts > 0
