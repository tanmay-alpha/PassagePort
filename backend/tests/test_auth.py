"""Accounts mode: sign-up, sign-in, sessions, guests, API tokens and throttling."""

from __future__ import annotations

import hashlib
import time
from datetime import timedelta

import pytest
from conftest import CSRF_HEADERS, PASSWORD, burst, create_collection, upload_file
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update

from passageport.auth import passwords, service
from passageport.auth.throttle import Throttle, login_throttle, reset_throttles
from passageport.db.schema import documents, sessions, users, utcnow
from passageport.errors import ApiError
from passageport.ingest import worker
from passageport.storage.blobs import get_blob_store

GENERIC = {"error": {"code": "unauthenticated", "message": "Invalid username or password."}}


def _credentials(username: str, password: str = PASSWORD, **extra) -> dict:
    return {"username": username, "password": password, **extra}


def _set_cookie(response) -> str:
    return response.headers["set-cookie"]


# --------------------------------------------------------------------------- session endpoint


def test_session_when_signed_out(accounts):
    response = accounts.client().get("/api/session")
    assert response.status_code == 200
    assert response.json() == {
        "auth_mode": "accounts",
        "authenticated": False,
        "user": None,
        "signup_enabled": True,
        "signup_requires_code": False,
        "guests_enabled": False,
    }


def test_local_mode_has_an_implicit_user_and_no_accounts(client):
    session = client.get("/api/session").json()
    assert session["auth_mode"] == "local"
    assert session["authenticated"] is True
    assert session["user"]["username"] == "local" and session["user"]["is_guest"] is False
    assert (session["signup_enabled"], session["guests_enabled"]) == (False, False)
    assert client.get("/api/session").json()["user"]["id"] == session["user"]["id"]

    for path, body in (
        ("/api/auth/signup", _credentials("alice")),
        ("/api/auth/login", _credentials("alice")),
        ("/api/auth/guest", None),
        ("/api/auth/tokens", {"name": "script"}),
    ):
        response = client.post(path, json=body)
        assert response.status_code == 403, path
        assert response.json()["error"]["code"] == "forbidden"
    assert client.post("/api/auth/logout").status_code == 204
    assert client.get("/api/auth/tokens").json() == []


def test_protected_endpoints_require_authentication(accounts):
    anonymous = accounts.client()
    for method, path in (
        ("GET", "/api/system"),
        ("GET", "/api/collections"),
        ("POST", "/api/collections"),
        ("GET", "/api/collections/x/documents"),
        ("GET", "/api/documents/x"),
        ("GET", "/api/documents/x/file"),
        ("GET", "/api/chunks/x"),
        ("GET", "/api/auth/tokens"),
    ):
        response = anonymous.request(method, path, json={"name": "x"} if method == "POST" else None)
        assert response.status_code == 401, path
        assert response.json() == {"error": {"code": "unauthenticated", "message": "Sign in to continue."}}
    assert anonymous.get("/api/health").json() == {"status": "ok"}


# --------------------------------------------------------------------------- sign-up


def test_signup_creates_account_and_session(accounts):
    client = accounts.client()
    response = client.post("/api/auth/signup", json=_credentials("Alice"))
    assert response.status_code == 200
    body = response.json()
    assert body["authenticated"] is True
    assert body["user"]["username"] == "alice" and body["user"]["is_guest"] is False

    assert client.get("/api/session").json()["user"] == body["user"]
    assert client.get("/api/collections").status_code == 200


def test_session_cookie_flags(make_accounts):
    insecure = make_accounts(cookie_secure=False).client()
    cookie = _set_cookie(insecure.post("/api/auth/signup", json=_credentials("alice")))
    attributes = {part.strip().lower() for part in cookie.split(";")[1:]}
    assert cookie.startswith("pp_session=")
    assert {"httponly", "samesite=lax", "path=/"} <= attributes
    assert "secure" not in attributes
    assert any(a.startswith("max-age=") for a in attributes)
    assert len(cookie.split(";")[0].split("=", 1)[1]) >= 43  # 32 random bytes, url-safe


def test_session_cookie_is_secure_by_default(make_accounts):
    accounts = make_accounts(cookie_secure=True)
    client = accounts.client()
    cookie = _set_cookie(client.post("/api/auth/signup", json=_credentials("alice")))
    attributes = {part.strip().lower() for part in cookie.split(";")[1:]}
    assert {"secure", "httponly", "samesite=lax", "path=/"} <= attributes
    assert client.get("/api/health").headers["strict-transport-security"] == "max-age=31536000"


def test_usernames_are_unique_ignoring_case_and_some_are_reserved(accounts):
    accounts.signup("alice")
    for taken in ("alice", "ALICE", "Alice", "local", "guest-1234abcd"):
        response = accounts.client().post("/api/auth/signup", json=_credentials(taken))
        assert response.status_code == 409, taken
        assert response.json()["error"] == {"code": "conflict", "message": "That username is not available."}


@pytest.mark.parametrize(
    "body",
    [
        _credentials("ab"),
        _credentials("a" * 33),
        _credentials("has space"),
        _credentials("semi;colon"),
        _credentials("alice", "short"),
        _credentials("alice", "x" * 201),
        {"username": "alice"},
        _credentials("alice", is_admin=True),
    ],
)
def test_signup_validation(accounts, body):
    response = accounts.client().post("/api/auth/signup", json=body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"
    assert PASSWORD not in response.text


def test_signup_can_be_disabled(make_accounts):
    accounts = make_accounts(allow_signup=False)
    client = accounts.client()
    assert client.get("/api/session").json()["signup_enabled"] is False
    response = client.post("/api/auth/signup", json=_credentials("alice"))
    assert response.status_code == 403
    assert response.json()["error"] == {"code": "forbidden", "message": "Sign-up is disabled on this server."}


def test_signup_code_is_required_when_configured(make_accounts):
    accounts = make_accounts(signup_code="open-sesame-42")
    client = accounts.client()
    session = client.get("/api/session")
    assert session.json()["signup_requires_code"] is True
    assert "open-sesame-42" not in session.text

    for attempt in (
        _credentials("alice"),
        _credentials("alice", signup_code="open-sesame-4"),
        _credentials("alice", signup_code=""),
    ):
        response = client.post("/api/auth/signup", json=attempt)
        assert response.status_code == 403
        assert response.json()["error"]["message"] == "The sign-up code is not valid."
    assert (
        client.post("/api/auth/signup", json=_credentials("alice", signup_code="open-sesame-42")).status_code
        == 200
    )


# --------------------------------------------------------------------------- sign-in / sign-out


def test_login_with_wrong_password_or_unknown_user_is_indistinguishable(accounts):
    accounts.signup("alice")
    client = accounts.client()

    wrong_password = client.post("/api/auth/login", json=_credentials("alice", "not the password"))
    unknown_user = client.post("/api/auth/login", json=_credentials("nobody", "not the password"))

    assert wrong_password.status_code == unknown_user.status_code == 401
    assert wrong_password.json() == unknown_user.json() == GENERIC
    assert "set-cookie" not in wrong_password.headers
    assert client.get("/api/collections").status_code == 401


def test_unknown_user_costs_a_real_password_verification(accounts, monkeypatch):
    """No timing oracle: a missing account is verified against a dummy hash, not skipped."""
    verified: list[str] = []
    real_verify = passwords._hasher.verify
    hasher_type = type(passwords._hasher)

    def spy(self, stored_hash, password):
        verified.append(stored_hash)
        return real_verify(stored_hash, password)

    monkeypatch.setattr(hasher_type, "verify", spy)
    accounts.client().post("/api/auth/login", json=_credentials("nobody"))
    assert len(verified) == 1 and verified[0].startswith("$argon2id$")


def test_login_is_case_insensitive_and_rotates_the_session(accounts):
    client = accounts.signup("alice")
    first_cookie = client.cookies.get("pp_session")

    response = client.post("/api/auth/login", json=_credentials("ALICE"))
    assert response.status_code == 200
    assert response.json()["user"]["username"] == "alice"
    second_cookie = client.cookies.get("pp_session")
    assert second_cookie and second_cookie != first_cookie

    replay = accounts.client()
    replay.cookies.set("pp_session", first_cookie)
    assert replay.get("/api/collections").status_code == 401  # the old session was revoked
    assert replay.get("/api/session").json()["authenticated"] is False
    assert client.get("/api/collections").status_code == 200


def test_logout_invalidates_the_session_server_side(accounts):
    client = accounts.signup("alice")
    stolen = client.cookies.get("pp_session")

    response = client.post("/api/auth/logout")
    assert response.status_code == 204
    assert 'pp_session=""' in _set_cookie(response) or "pp_session=;" in _set_cookie(response)
    assert "max-age=0" in _set_cookie(response).lower()
    assert client.get("/api/collections").status_code == 401

    replay = accounts.client()
    replay.cookies.set("pp_session", stolen)
    assert replay.get("/api/collections").status_code == 401
    assert accounts.client().post("/api/auth/logout").status_code == 204  # idempotent, even signed out


def test_only_token_hashes_are_stored(accounts):
    client = accounts.signup("alice")
    cookie = client.cookies.get("pp_session")
    token = client.post("/api/auth/tokens", json={"name": "ci"}).json()["token"]

    with accounts.app.state.engine.connect() as conn:
        rows = conn.execute(select(sessions)).all()
        password_hash = conn.execute(select(users.c.password_hash)).scalar_one()
    stored = {row.kind: row.token_hash for row in rows}
    assert stored == {
        "web": hashlib.sha256(cookie.encode()).hexdigest(),
        "api": hashlib.sha256(token.encode()).hexdigest(),
    }
    dump = repr(rows)
    assert cookie not in dump and token not in dump
    assert password_hash.startswith("$argon2id$") and PASSWORD not in password_hash


def test_expired_sessions_are_rejected(accounts):
    client = accounts.signup("alice")
    with accounts.app.state.engine.begin() as conn:
        conn.execute(update(sessions).values(expires_at=utcnow() - timedelta(seconds=1)))
    response = client.get("/api/collections")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"
    assert client.get("/api/session").json()["authenticated"] is False


def test_session_lifetime_follows_settings(make_accounts):
    accounts = make_accounts(session_ttl_hours=2)
    before = utcnow()
    client = accounts.signup("alice")
    with accounts.app.state.engine.connect() as conn:
        expires = conn.execute(select(sessions.c.expires_at)).scalar_one()
    assert before + timedelta(hours=2) <= expires <= utcnow() + timedelta(hours=2)
    assert (
        "max-age=7200"
        in client.post("/api/auth/login", json=_credentials("alice")).headers["set-cookie"].lower()
    )


def test_login_throttle(accounts):
    accounts.signup("alice")
    client = accounts.client()
    for _ in range(login_throttle.limit):
        assert client.post("/api/auth/login", json=_credentials("alice", "wrong password")).status_code == 401

    blocked = client.post("/api/auth/login", json=_credentials("alice"))  # even the right password
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "rate_limited"
    # The client address is throttled too, so spraying other usernames does not help.
    assert client.post("/api/auth/login", json=_credentials("bob-other")).status_code == 429

    reset_throttles()
    assert client.post("/api/auth/login", json=_credentials("alice")).status_code == 200


def test_successful_login_clears_the_username_counter(accounts):
    accounts.signup("alice")
    client = accounts.client()
    for _ in range(3):
        client.post("/api/auth/login", json=_credentials("alice", "wrong password"))
    assert client.post("/api/auth/login", json=_credentials("alice")).status_code == 200
    login_throttle.reset("ip:testclient")
    for _ in range(login_throttle.limit - 1):
        client.post("/api/auth/login", json=_credentials("alice", "wrong password"))
    assert client.post("/api/auth/login", json=_credentials("alice")).status_code == 200


def test_throttle_reservation_is_atomic():
    throttle = Throttle(5, 60.0, "slow down")

    def attempt(_index: int) -> bool:
        try:
            throttle.reserve("user:alice", "ip:10.0.0.1")
        except ApiError as exc:
            assert exc.status_code == 429
            return False
        return True

    assert sum(burst(40, attempt)) == 5

    # A released reservation frees its slot; an unreleased one keeps counting.
    other = Throttle(1, 60.0, "slow down")
    ticket = other.reserve("k")
    with pytest.raises(ApiError):
        other.reserve("k")
    other.release(ticket, "k")
    other.reserve("k")


def test_concurrent_login_burst_is_throttled_before_any_hashing(accounts, monkeypatch):
    """Thirty guesses fired at once: only ``limit`` of them may reach the password hash. Counting
    failures after verification would let the whole burst through."""
    accounts.signup("alice")
    verified: list[int] = []
    real_verify = service.verify_password

    def slow_verify(stored_hash, password):
        verified.append(1)
        time.sleep(0.05)  # keep the attempts overlapping
        return real_verify(stored_hash, password)

    monkeypatch.setattr(service, "verify_password", slow_verify)

    def guess(index: int) -> int:
        return (
            accounts.client()
            .post("/api/auth/login", json=_credentials("alice", f"wrong password {index}"))
            .status_code
        )

    statuses = burst(30, guess)

    assert statuses.count(401) == login_throttle.limit
    assert statuses.count(429) == 30 - login_throttle.limit
    assert len(verified) == login_throttle.limit


def test_password_hashing():
    hashed = passwords.hash_password(PASSWORD)
    assert hashed.startswith("$argon2id$")
    assert hashed != passwords.hash_password(PASSWORD)  # salted
    assert passwords.verify_password(hashed, PASSWORD)
    assert not passwords.verify_password(hashed, PASSWORD + "x")
    assert not passwords.verify_password(None, PASSWORD)
    assert not passwords.verify_password("not-a-hash", PASSWORD)
    assert not passwords.needs_rehash(hashed)


# --------------------------------------------------------------------------- API tokens


def test_api_token_lifecycle(accounts):
    browser = accounts.signup("alice")
    created = browser.post("/api/auth/tokens", json={"name": "  backup\x00 script "})
    assert created.status_code == 200
    token = created.json()["token"]
    assert token.startswith("pp_") and len(token) >= 46
    assert created.json()["name"] == "backup script"

    listing = browser.get("/api/auth/tokens").json()
    assert listing == [
        {
            "id": created.json()["id"],
            "name": "backup script",
            "created_at": created.json()["created_at"],
            "token": None,
        }
    ]

    # A script: no cookie jar, no CSRF header, only the bearer token.
    script = TestClient(accounts.app, headers={"Authorization": f"Bearer {token}"})
    made = script.post("/api/collections", json={"name": "From a script"})
    assert made.status_code == 201
    assert [c["name"] for c in browser.get("/api/collections").json()] == ["From a script"]
    assert script.get("/api/session").json()["user"]["username"] == "alice"

    assert browser.delete(f"/api/auth/tokens/{created.json()['id']}").status_code == 204
    assert script.get("/api/collections").status_code == 401
    assert browser.get("/api/auth/tokens").json() == []
    assert browser.delete(f"/api/auth/tokens/{created.json()['id']}").status_code == 404


@pytest.mark.parametrize(
    "authorization",
    ["Bearer pp_" + "A" * 43, "Bearer not-a-passageport-token", "Bearer ", "bearer", "BEARER x"],
)
def test_invalid_bearer_token_never_falls_back_to_the_cookie(accounts, authorization):
    """A request carrying an Authorization header skips the CSRF check, so it must authenticate
    by that header alone - even when a perfectly valid session cookie is attached."""
    client = accounts.signup("alice")
    assert client.get("/api/collections").status_code == 200

    response = client.get("/api/collections", headers={"Authorization": authorization})
    assert response.status_code == 401
    assert response.json() == {"error": {"code": "unauthenticated", "message": "Invalid API token."}}


def test_other_authorization_schemes_use_the_cookie_and_stay_csrf_protected(accounts):
    """Basic credentials added for a reverse proxy must neither break sessions nor skip CSRF."""
    client = accounts.signup("alice")
    proxy = {"Authorization": "Basic YWxpY2U6cHc="}
    assert client.get("/api/collections", headers=proxy).status_code == 200

    bare = TestClient(accounts.app, cookies=None)
    bare.cookies.set("pp_session", client.cookies.get("pp_session"))
    forged = bare.post("/api/collections", json={"name": "forged"}, headers=proxy)
    assert forged.status_code == 403
    assert forged.json()["error"]["code"] == "csrf"


def test_session_cookie_is_not_accepted_as_a_bearer_token(accounts):
    client = accounts.signup("alice")
    cookie = client.cookies.get("pp_session")
    token = client.post("/api/auth/tokens", json={"name": "t"}).json()["token"]

    assert (
        TestClient(accounts.app, headers={"Authorization": f"Bearer {cookie}"})
        .get("/api/collections")
        .status_code
        == 401
    )
    as_cookie = accounts.client()
    as_cookie.cookies.set("pp_session", token)
    assert as_cookie.get("/api/collections").status_code == 401


def test_tokens_survive_logout_but_not_validation(accounts):
    browser = accounts.signup("alice")
    token = browser.post("/api/auth/tokens", json={"name": "t"}).json()["token"]
    browser.post("/api/auth/logout")
    assert (
        TestClient(accounts.app, headers={"Authorization": f"Bearer {token}"})
        .get("/api/collections")
        .status_code
        == 200
    )

    assert accounts.signup("bob").post("/api/auth/tokens", json={"name": ""}).status_code == 422


def test_token_limit_per_user(accounts, monkeypatch):
    monkeypatch.setattr(service, "MAX_API_TOKENS_PER_USER", 2)
    client = accounts.signup("alice")
    assert client.post("/api/auth/tokens", json={"name": "one"}).status_code == 200
    assert client.post("/api/auth/tokens", json={"name": "two"}).status_code == 200
    third = client.post("/api/auth/tokens", json={"name": "three"})
    assert third.status_code == 409
    assert third.json()["error"]["code"] == "quota_exceeded"


def test_concurrent_token_creation_respects_the_limit(accounts, monkeypatch):
    monkeypatch.setattr(service, "MAX_API_TOKENS_PER_USER", 2)
    client = accounts.signup("alice")
    cookie = client.cookies.get("pp_session")

    def create(index: int) -> int:
        own = accounts.client()
        own.cookies.set("pp_session", cookie)
        return own.post("/api/auth/tokens", json={"name": f"token {index}"}).status_code

    statuses = burst(8, create)
    assert sorted(statuses) == [200] * 2 + [409] * 6, statuses
    assert len(client.get("/api/auth/tokens").json()) == 2


# --------------------------------------------------------------------------- guests


def test_guest_access_is_off_by_default(accounts):
    response = accounts.client().post("/api/auth/guest")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"


def test_guest_session(make_accounts):
    accounts = make_accounts(allow_guests=True, guest_ttl_hours=3)
    client = accounts.client()
    assert client.get("/api/session").json()["guests_enabled"] is True

    response = client.post("/api/auth/guest")
    assert response.status_code == 200
    user = response.json()["user"]
    assert user["is_guest"] is True
    assert user["username"].startswith("guest-") and len(user["username"]) == len("guest-") + 8
    assert client.post("/api/collections", json={"name": "Scratch"}).status_code == 201

    other = accounts.client().post("/api/auth/guest").json()["user"]
    assert other["username"] != user["username"]
    forbidden = client.post("/api/auth/tokens", json={"name": "t"})
    assert forbidden.status_code == 403

    # A guest session never outlives the guest account.
    with accounts.app.state.engine.connect() as conn:
        expires = conn.execute(
            select(sessions.c.expires_at).where(sessions.c.user_id == user["id"])
        ).scalar_one()
    assert expires <= utcnow() + timedelta(hours=3)
    # Guests have no password, so nobody can sign in as one.
    assert client.post("/api/auth/login", json=_credentials(user["username"])).json() == GENERIC


def test_expired_guests_are_purged_with_their_data(make_accounts):
    accounts = make_accounts(allow_guests=True, guest_ttl_hours=1)
    engine = accounts.app.state.engine
    member = accounts.signup("alice")
    member_collection = create_collection(member, "Mine")
    upload_file(member, member_collection, "keep.txt", b"member data")

    guest = accounts.client()
    guest_id = guest.post("/api/auth/guest").json()["user"]["id"]
    collection = create_collection(guest, "Temporary")
    upload_file(guest, collection, "temp.txt", b"guest data")
    accounts.index_all()
    with engine.connect() as conn:
        guest_blob = conn.execute(
            select(documents.c.blob_key).where(documents.c.owner_id == guest_id)
        ).scalar_one()
    store = get_blob_store(accounts.settings, engine)
    assert store.exists(guest_blob)
    assert service.purge_expired_guests(engine, accounts.settings) == 0  # not expired yet

    with engine.begin() as conn:
        conn.execute(
            update(users).where(users.c.id == guest_id).values(created_at=utcnow() - timedelta(hours=2))
        )
    # Creating the next guest triggers the purge.
    assert accounts.client().post("/api/auth/guest").status_code == 200

    with engine.connect() as conn:
        assert (
            conn.execute(select(func.count()).select_from(users).where(users.c.id == guest_id)).scalar_one()
            == 0
        )
        assert conn.execute(select(func.count()).select_from(documents)).scalar_one() == 1
        assert (
            conn.execute(
                select(func.count()).select_from(sessions).where(sessions.c.user_id == guest_id)
            ).scalar_one()
            == 0
        )
    assert not store.exists(guest_blob)
    assert guest.get("/api/collections").status_code == 401
    assert [c["name"] for c in member.get("/api/collections").json()] == ["Mine"]
    assert len(member.get(f"/api/collections/{member_collection}/documents").json()) == 1


def test_startup_purges_expired_guests(make_accounts, make_app):
    accounts = make_accounts(allow_guests=True, guest_ttl_hours=1)
    guest_id = accounts.client().post("/api/auth/guest").json()["user"]["id"]
    with accounts.app.state.engine.begin() as conn:
        conn.execute(update(users).values(created_at=utcnow() - timedelta(hours=5)))

    with (
        TestClient(make_app(accounts.settings), headers=CSRF_HEADERS) as restarted,
        restarted.app.state.engine.connect() as conn,
    ):
        assert conn.execute(select(users).where(users.c.id == guest_id)).first() is None


def test_running_worker_purges_expired_guests_periodically(make_accounts, monkeypatch):
    """A server that never restarts and sees no new guests must still honour the guest TTL."""
    monkeypatch.setattr(worker, "POLL_SECONDS", 0.1)
    monkeypatch.setattr(worker, "MAINTENANCE_INTERVAL_SECONDS", 0.3)
    accounts = make_accounts(allow_guests=True, guest_ttl_hours=1, job_mode="thread")
    engine = accounts.app.state.engine
    store = get_blob_store(accounts.settings, engine)
    with accounts.client() as guest:
        guest_id = guest.post("/api/auth/guest").json()["user"]["id"]
        upload_file(guest, create_collection(guest, "Temporary"), "temp.txt", b"guest data")
        with engine.connect() as conn:
            blob_key = conn.execute(select(documents.c.blob_key)).scalar_one()
        time.sleep(1.0)  # several maintenance rounds: a guest inside its TTL is left alone
        assert guest.get("/api/collections").status_code == 200

        with engine.begin() as conn:
            conn.execute(
                update(users).where(users.c.id == guest_id).values(created_at=utcnow() - timedelta(hours=2))
            )

        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and store.exists(blob_key):
            time.sleep(0.1)
        assert not store.exists(blob_key)
        with engine.connect() as conn:
            assert conn.execute(select(users).where(users.c.id == guest_id)).first() is None
            assert conn.execute(select(func.count()).select_from(documents)).scalar_one() == 0
