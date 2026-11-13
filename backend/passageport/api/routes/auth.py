"""Session, account and API-token endpoints.

Writes use their own transactions (inside ``auth.service``) so they are committed before the
response - and its cookie - goes out.
"""

from __future__ import annotations

from fastapi import APIRouter, Request, Response

from passageport.api.deps import Conn, CurrentUser, EngineDep, SettingsDep
from passageport.api.schemas import ApiTokenIn, ApiTokenOut, CredentialsIn, SessionOut, UserOut
from passageport.auth import service
from passageport.config import Settings
from passageport.domain import User
from passageport.storage.validate import clean_text

router = APIRouter(prefix="/api", tags=["auth"])


def _session_out(settings: Settings, user: User | None) -> SessionOut:
    accounts = settings.auth_mode == "accounts"
    return SessionOut(
        auth_mode=settings.auth_mode,
        authenticated=user is not None,
        user=UserOut(id=user.id, username=user.username, is_guest=user.is_guest) if user else None,
        signup_enabled=accounts and settings.allow_signup,
        signup_requires_code=accounts and settings.allow_signup and settings.signup_code is not None,
        guests_enabled=accounts and settings.allow_guests,
    )


def _set_session_cookie(response: Response, settings: Settings, secret: str) -> None:
    response.set_cookie(
        service.SESSION_COOKIE,
        secret,
        max_age=settings.session_ttl_hours * 3600,
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
    )


def _clear_session_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        service.SESSION_COOKIE, path="/", httponly=True, samesite="lax", secure=settings.cookie_secure
    )


@router.get("/session", response_model=SessionOut)
def get_session(request: Request, settings: SettingsDep) -> SessionOut:
    """Who am I, and which sign-in options does this server offer. 200 also when signed out."""
    return _session_out(settings, service.optional_user(request))


@router.post("/auth/signup", response_model=SessionOut)
def signup(
    body: CredentialsIn, request: Request, response: Response, engine: EngineDep, settings: SettingsDep
) -> SessionOut:
    user, secret = service.signup(
        engine,
        settings,
        username=body.username,
        password=body.password,
        code=body.signup_code,
        address=service.client_address(request),
    )
    _set_session_cookie(response, settings, secret)
    return _session_out(settings, user)


@router.post("/auth/login", response_model=SessionOut)
def login(
    body: CredentialsIn, request: Request, response: Response, engine: EngineDep, settings: SettingsDep
) -> SessionOut:
    user, secret = service.login(
        engine,
        settings,
        username=body.username,
        password=body.password,
        address=service.client_address(request),
        previous_secret=request.cookies.get(service.SESSION_COOKIE),
    )
    _set_session_cookie(response, settings, secret)
    return _session_out(settings, user)


@router.post("/auth/guest", response_model=SessionOut)
def guest(request: Request, response: Response, engine: EngineDep, settings: SettingsDep) -> SessionOut:
    user, secret = service.create_guest(engine, settings, service.client_address(request))
    _set_session_cookie(response, settings, secret)
    return _session_out(settings, user)


@router.post("/auth/logout", status_code=204)
def logout(request: Request, engine: EngineDep, settings: SettingsDep) -> Response:
    """Revoke the current session server-side and drop the cookie. Idempotent."""
    service.logout(engine, request.cookies.get(service.SESSION_COOKIE))
    response = Response(status_code=204)
    _clear_session_cookie(response, settings)
    return response


@router.get("/auth/tokens", response_model=list[ApiTokenOut])
def list_tokens(conn: Conn, user: CurrentUser) -> list[ApiTokenOut]:
    return [
        ApiTokenOut(id=row.id, name=row.name or "", created_at=row.created_at)
        for row in service.list_api_tokens(conn, user)
    ]


@router.post("/auth/tokens", response_model=ApiTokenOut)
def create_token(
    body: ApiTokenIn, user: CurrentUser, engine: EngineDep, settings: SettingsDep
) -> ApiTokenOut:
    """Create a bearer token for scripts. The secret is shown in this response only."""
    name = clean_text(body.name, 100) or "API token"
    row, secret = service.create_api_token(engine, settings, user, name)
    return ApiTokenOut(id=row.id, name=row.name or "", created_at=row.created_at, token=secret)


@router.delete("/auth/tokens/{token_id}", status_code=204)
def delete_token(token_id: str, user: CurrentUser, engine: EngineDep) -> Response:
    service.delete_api_token(engine, user, token_id)
    return Response(status_code=204)
