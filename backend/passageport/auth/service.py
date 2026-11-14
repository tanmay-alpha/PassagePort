"""Users, sessions and API tokens.

Secrets (session cookies, API tokens) are random and only their SHA-256 is stored, so a leaked
database does not contain anything that can be replayed. Sessions expire server-side.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
from datetime import datetime, timedelta

from fastapi import Request
from sqlalchemy import Connection, Engine, Row, delete, insert, or_, select, update
from sqlalchemy.exc import IntegrityError

from passageport.auth.passwords import hash_password, needs_rehash, verify_password
from passageport.auth.throttle import login_throttle, signup_throttle
from passageport.config import Settings
from passageport.db.repos import blob_keys_of_users, lock_user, new_id
from passageport.db.schema import sessions, users, utcnow
from passageport.domain import User
from passageport.errors import ApiError, not_found
from passageport.storage.blobs import get_blob_store

log = logging.getLogger("passageport.auth")

SESSION_COOKIE = "pp_session"
API_TOKEN_PREFIX = "pp_"  # noqa: S105 - a public prefix, not a secret
LOCAL_USERNAME = "local"
GUEST_PREFIX = "guest-"
MAX_API_TOKENS_PER_USER = 20
INVALID_CREDENTIALS = "Invalid username or password."


def unauthenticated(message: str = "Sign in to continue.") -> ApiError:
    return ApiError(401, "unauthenticated", message)


def hash_token(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def _to_user(row: Row) -> User:
    return User(id=row.id, username=row.username, is_guest=bool(row.is_guest))


def client_address(request: Request) -> str:
    return request.client.host if request.client else "unknown"


# --------------------------------------------------------------------------- request authentication


def ensure_local_user(engine: Engine) -> User:
    """The single implicit user of local mode, created on first use."""
    query = select(users).where(users.c.username == LOCAL_USERNAME)
    with engine.connect() as conn:
        row = conn.execute(query).first()
    if row is None:
        try:
            with engine.begin() as conn:
                conn.execute(
                    insert(users).values(
                        id=new_id(), username=LOCAL_USERNAME, is_guest=False, created_at=utcnow()
                    )
                )
        except IntegrityError:
            pass  # a concurrent first request created it
        with engine.connect() as conn:
            row = conn.execute(query).one()
    return _to_user(row)


def _user_for_secret(conn: Connection, secret: str, kind: str) -> User | None:
    row = conn.execute(
        select(users.c.id, users.c.username, users.c.is_guest)
        .select_from(sessions.join(users, users.c.id == sessions.c.user_id))
        .where(
            sessions.c.token_hash == hash_token(secret),
            sessions.c.kind == kind,
            or_(sessions.c.expires_at.is_(None), sessions.c.expires_at > utcnow()),
        )
    ).first()
    return _to_user(row) if row is not None else None


def authenticate_request(request: Request) -> User:
    """Resolve the user of a request, or raise 401.

    local mode: always the implicit local user. accounts mode: a bearer API token when the
    request carries ``Authorization: Bearer ...``, otherwise the session cookie. The two are never
    mixed: a bearer request is exempt from the CSRF check, so it must not be able to fall back to
    the cookie. Other schemes (e.g. Basic credentials meant for a reverse proxy) are ignored.
    """
    cached = getattr(request.state, "pp_user", None)
    if cached is not None:
        return cached
    settings: Settings = request.app.state.settings
    engine: Engine = request.app.state.engine
    user: User | None
    if settings.auth_mode == "local":
        user = getattr(request.app.state, "local_user", None)
        if user is None:
            user = ensure_local_user(engine)
            request.app.state.local_user = user
    else:
        scheme, _, secret = request.headers.get("authorization", "").partition(" ")
        if scheme.lower() == "bearer":
            secret = secret.strip()
            user = None
            if secret.startswith(API_TOKEN_PREFIX):
                with engine.connect() as conn:
                    user = _user_for_secret(conn, secret, "api")
            if user is None:
                raise unauthenticated("Invalid API token.")
        else:
            cookie = request.cookies.get(SESSION_COOKIE)
            if not cookie:
                raise unauthenticated()
            with engine.connect() as conn:
                user = _user_for_secret(conn, cookie, "web")
            if user is None:
                raise unauthenticated("Your session has expired. Sign in again.")
    request.state.pp_user = user
    return user


def optional_user(request: Request) -> User | None:
    try:
        return authenticate_request(request)
    except ApiError:
        return None


# --------------------------------------------------------------------------- sessions


def _create_session(conn: Connection, user_id: str, expires_at: datetime) -> str:
    secret = secrets.token_urlsafe(32)
    conn.execute(
        insert(sessions).values(
            id=new_id(),
            token_hash=hash_token(secret),
            user_id=user_id,
            kind="web",
            created_at=utcnow(),
            expires_at=expires_at,
        )
    )
    return secret


def _session_expiry(settings: Settings) -> datetime:
    return utcnow() + timedelta(hours=settings.session_ttl_hours)


def _require_accounts_mode(settings: Settings) -> None:
    if settings.auth_mode != "accounts":
        raise ApiError(403, "forbidden", "This server runs in local mode; accounts are not used.")


def signup(
    engine: Engine, settings: Settings, *, username: str, password: str, code: str | None, address: str
) -> tuple[User, str]:
    """Create an account and its first session. Returns the user and the session secret."""
    _require_accounts_mode(settings)
    if not settings.allow_signup:
        raise ApiError(403, "forbidden", "Sign-up is disabled on this server.")
    signup_throttle.reserve(f"ip:{address}")
    if settings.signup_code is not None:
        expected = settings.signup_code.get_secret_value().encode()
        if not hmac.compare_digest((code or "").encode(), expected):
            raise ApiError(403, "forbidden", "The sign-up code is not valid.")
    username = username.lower()
    taken = ApiError(409, "conflict", "That username is not available.")
    if username == LOCAL_USERNAME or username.startswith(GUEST_PREFIX):
        raise taken
    password_hash = hash_password(password)
    user = User(id=new_id(), username=username, is_guest=False)
    with engine.begin() as conn:
        if conn.execute(select(users.c.id).where(users.c.username == username)).first() is not None:
            raise taken
        try:
            conn.execute(
                insert(users).values(
                    id=user.id,
                    username=username,
                    password_hash=password_hash,
                    is_guest=False,
                    created_at=utcnow(),
                )
            )
        except IntegrityError:
            raise taken from None
        secret = _create_session(conn, user.id, _session_expiry(settings))
    return user, secret


def login(
    engine: Engine,
    settings: Settings,
    *,
    username: str,
    password: str,
    address: str,
    previous_secret: str | None,
) -> tuple[User, str]:
    """Verify credentials and start a new session (the presented one, if any, is revoked).

    Unknown user and wrong password are indistinguishable: same message, same amount of work.
    """
    _require_accounts_mode(settings)
    username = username.lower()
    user_key, address_key = f"user:{username}", f"ip:{address}"
    # Reserved before the password is verified: concurrent guesses are counted before, not
    # after, they have each cost a full argon2 computation.
    ticket = login_throttle.reserve(user_key, address_key)
    with engine.connect() as conn:
        row = conn.execute(select(users).where(users.c.username == username)).first()
    stored_hash = row.password_hash if row is not None else None
    if not verify_password(stored_hash, password) or row is None:
        raise unauthenticated(INVALID_CREDENTIALS)  # the reservation stays: it was a failure
    login_throttle.release(ticket, address_key)
    login_throttle.reset(user_key)
    new_hash = hash_password(password) if needs_rehash(stored_hash or "") else None
    with engine.begin() as conn:
        if new_hash is not None:
            conn.execute(update(users).where(users.c.id == row.id).values(password_hash=new_hash))
        if previous_secret:
            conn.execute(delete(sessions).where(sessions.c.token_hash == hash_token(previous_secret)))
        conn.execute(
            delete(sessions).where(
                sessions.c.user_id == row.id, sessions.c.kind == "web", sessions.c.expires_at < utcnow()
            )
        )
        secret = _create_session(conn, row.id, _session_expiry(settings))
    return _to_user(row), secret


def create_guest(engine: Engine, settings: Settings, address: str) -> tuple[User, str]:
    """Create a throw-away account. It and everything it uploads is purged after the guest TTL."""
    _require_accounts_mode(settings)
    if not settings.allow_guests:
        raise ApiError(403, "forbidden", "Guest access is disabled on this server.")
    signup_throttle.reserve(f"ip:{address}")
    purge_expired_guests(engine, settings)
    created_at = utcnow()
    guest_expiry = created_at + timedelta(hours=settings.guest_ttl_hours)
    user = User(id=new_id(), username=f"{GUEST_PREFIX}{secrets.token_hex(4)}", is_guest=True)
    with engine.begin() as conn:
        conn.execute(
            insert(users).values(id=user.id, username=user.username, is_guest=True, created_at=created_at)
        )
        secret = _create_session(conn, user.id, min(guest_expiry, _session_expiry(settings)))
    return user, secret


def logout(engine: Engine, secret: str | None) -> None:
    if not secret:
        return
    with engine.begin() as conn:
        conn.execute(
            delete(sessions).where(sessions.c.token_hash == hash_token(secret), sessions.c.kind == "web")
        )


def purge_expired_guests(engine: Engine, settings: Settings) -> int:
    """Delete guest accounts older than the guest TTL together with all their data."""
    cutoff = utcnow() - timedelta(hours=settings.guest_ttl_hours)
    store = get_blob_store(settings, engine)
    with engine.begin() as conn:
        expired_where = (users.c.is_guest.is_(True)) & (users.c.created_at < cutoff)
        if conn.dialect.name == "sqlite":
            conn.execute(update(users).where(expired_where).values(is_guest=users.c.is_guest))
        expired = list(
            conn.execute(
                select(users.c.id).where(expired_where).order_by(users.c.id).with_for_update()
            ).scalars()
        )
        if not expired:
            return 0
        blob_keys = blob_keys_of_users(conn, expired)
        # Collections, documents, pages, chunks, jobs and sessions go with the user (ON DELETE CASCADE).
        conn.execute(delete(users).where(users.c.id.in_(expired)))
        store.remove_in_transaction(conn, blob_keys)
    store.remove_files(blob_keys)
    log.info("purged %d expired guest account(s)", len(expired))
    return len(expired)


# --------------------------------------------------------------------------- API tokens


def _require_token_owner(settings: Settings, user: User) -> None:
    _require_accounts_mode(settings)
    if user.is_guest:
        raise ApiError(403, "forbidden", "Guest accounts cannot create API tokens.")


def list_api_tokens(conn: Connection, user: User) -> list[Row]:
    return list(
        conn.execute(
            select(sessions.c.id, sessions.c.name, sessions.c.created_at)
            .where(sessions.c.user_id == user.id, sessions.c.kind == "api")
            .order_by(sessions.c.created_at.desc(), sessions.c.id)
        ).all()
    )


def create_api_token(engine: Engine, settings: Settings, user: User, name: str) -> tuple[Row, str]:
    """Create a bearer token. The secret is returned once and cannot be recovered later."""
    _require_token_owner(settings, user)
    secret = API_TOKEN_PREFIX + secrets.token_urlsafe(32)
    token_id = new_id()
    with engine.begin() as conn:
        lock_user(conn, user.id)  # the count below must not race with a concurrent creation
        if len(list_api_tokens(conn, user)) >= MAX_API_TOKENS_PER_USER:
            raise ApiError(409, "quota_exceeded", "Token limit reached. Delete a token you no longer use.")
        conn.execute(
            insert(sessions).values(
                id=token_id,
                token_hash=hash_token(secret),
                user_id=user.id,
                kind="api",
                name=name,
                created_at=utcnow(),
                expires_at=None,
            )
        )
        row = conn.execute(
            select(sessions.c.id, sessions.c.name, sessions.c.created_at).where(sessions.c.id == token_id)
        ).one()
    return row, secret


def delete_api_token(engine: Engine, user: User, token_id: str) -> None:
    with engine.begin() as conn:
        result = conn.execute(
            delete(sessions).where(
                sessions.c.id == token_id, sessions.c.user_id == user.id, sessions.c.kind == "api"
            )
        )
    if result.rowcount == 0:
        raise not_found("Token")
