"""HTTP hardening, as pure ASGI middleware so every rejection is the standard error JSON.

Outermost to innermost:

1. ``SecurityHeadersMiddleware`` - response headers on everything, including rejections below.
2. ``HostGuardMiddleware`` (local mode) - only loopback ``Host`` headers are served. Local mode has
   no login, so this is what stops DNS-rebinding pages and accidental LAN exposure.
3. ``CORSMiddleware`` - only when ``cors_origins`` is configured; never a wildcard.
4. ``CsrfMiddleware`` - state-changing requests need the ``X-PassagePort-CSRF`` header (which a
   cross-site form or fetch cannot send without a CORS preflight we never grant) and, when the
   browser sends ``Origin``, an origin we trust.
5. ``BodyLimitMiddleware`` - bounds request bodies before anything is parsed or spooled to disk.

``/api/docs`` (Swagger UI) loads its script and stylesheet from a CDN and uses an inline bootstrap
script, so that one path gets a dedicated, relaxed CSP; the page is static and shows no user data.
"""

from __future__ import annotations

import logging
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from starlette.datastructures import Headers, MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from passageport.config import Settings

log = logging.getLogger("passageport.http")

CSRF_HEADER = "x-passageport-csrf"
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
MAX_BODY_BYTES = 1024 * 1024  # JSON endpoints; uploads get max_upload_bytes plus form overhead
MULTIPART_OVERHEAD_BYTES = 1024 * 1024

APP_CSP = (
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; "
    "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
)
DOCS_PATH = "/api/docs"
DOCS_CSP = (
    "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; "
    "style-src 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https://fastapi.tiangolo.com; "
    "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
)
PERMISSIONS_POLICY = (
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), "
    "payment=(), usb=()"
)

_STATUS_CODES = {
    400: "invalid_request",
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    405: "invalid_request",
    409: "conflict",
    413: "payload_too_large",
    415: "unsupported_file",
    422: "invalid_request",
    429: "rate_limited",
}
_STATUS_MESSAGES = {
    404: "Not found.",
    405: "Method not allowed.",
    413: "The request is too large.",
}


def error_response(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


def hostname(host: str | None) -> str:
    """Lower-cased host without the port; IPv6 literals keep their brackets."""
    host = (host or "").strip().lower()
    if host.startswith("["):
        end = host.find("]")
        return host[: end + 1] if end != -1 else host
    return host.split(":", 1)[0]


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self._hsts = settings.auth_mode == "accounts" and settings.cookie_secure

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path: str = scope["path"]

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers.setdefault("X-Content-Type-Options", "nosniff")
                headers.setdefault("Referrer-Policy", "no-referrer")
                headers.setdefault("X-Frame-Options", "DENY")
                headers.setdefault("Permissions-Policy", PERMISSIONS_POLICY)
                headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
                # File downloads set their own, stricter policy; everything else gets the app's.
                headers.setdefault("Content-Security-Policy", DOCS_CSP if path == DOCS_PATH else APP_CSP)
                if path.startswith("/api/"):
                    headers.setdefault("Cache-Control", "no-store")
                if self._hsts:
                    headers.setdefault("Strict-Transport-Security", "max-age=31536000")
            await send(message)

        if "\x00" in path or b"%00" in scope.get("query_string", b""):
            # NUL can never be part of a valid id or filter, and PostgreSQL rejects it in text
            # parameters with an error that would otherwise surface as a 500.
            response = error_response(400, "invalid_request", "Malformed request.")
            await response(scope, receive, send_with_headers)
            return
        await self.app(scope, receive, send_with_headers)


class HostGuardMiddleware:
    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self._allowed = frozenset(h.lower() for h in settings.local_allowed_hosts)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and hostname(Headers(scope=scope).get("host")) not in self._allowed:
            response = error_response(
                403,
                "forbidden",
                "This PassagePort instance runs in local mode and only answers on localhost.",
            )
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


class CsrfMiddleware:
    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self._local = settings.auth_mode == "local"
        self._trusted_origins = frozenset(o.rstrip("/").lower() for o in settings.cors_origins)
        self._local_hosts = frozenset(h.lower() for h in settings.local_allowed_hosts)

    def _origin_trusted(self, origin: str, host: str | None) -> bool:
        origin = origin.strip().lower()
        if origin in self._trusted_origins:
            return True
        parts = urlsplit(origin)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            return False  # includes the opaque origin "null"
        # Same origin. The scheme is not compared: behind a TLS-terminating proxy the app sees
        # http while the browser reports https.
        if parts.netloc == (host or "").strip().lower():
            return True
        # Local mode: another port on this machine (the Vite dev server proxying to the API).
        return self._local and hostname(parts.netloc) in self._local_hosts

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] not in UNSAFE_METHODS:
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        # Bearer tokens are not sent by browsers on their own, so such requests cannot be forged
        # cross-site. Authentication never falls back to the cookie when this header is present.
        scheme = headers.get("authorization", "").partition(" ")[0].lower()
        bearer = not self._local and scheme == "bearer"
        if not bearer:
            origin = headers.get("origin")
            if headers.get(CSRF_HEADER) != "1" or (
                origin is not None and not self._origin_trusted(origin, headers.get("host"))
            ):
                response = error_response(
                    403, "csrf", "Request blocked: missing or invalid cross-site request protection."
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


class BodyLimitMiddleware:
    """Reject oversized request bodies: by ``Content-Length`` up front, and by counting bytes for
    bodies sent without one (chunked transfer)."""

    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self._max_multipart = settings.max_upload_bytes + MULTIPART_OVERHEAD_BYTES

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] in ("GET", "HEAD", "OPTIONS"):
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        multipart = headers.get("content-type", "").lower().startswith("multipart/form-data")
        limit = self._max_multipart if multipart else MAX_BODY_BYTES
        too_large = StarletteHTTPException(
            413,
            "The file is larger than the upload limit." if multipart else _STATUS_MESSAGES[413],
        )
        declared = headers.get("content-length")
        if declared is not None:
            if not declared.isdigit():
                await error_response(400, "invalid_request", "Invalid Content-Length header.")(
                    scope, receive, send
                )
                return
            if int(declared) > limit:
                await error_response(413, "payload_too_large", str(too_large.detail))(scope, receive, send)
                return

        received = 0

        async def counting_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    # Raised inside the endpoint's body read; rendered by the handler below.
                    raise too_large
            return message

        await self.app(scope, counting_receive, send)


async def _http_exception_handler(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
    """Framework-raised HTTP errors (unknown route, wrong method, ...) in the standard shape."""
    status = exc.status_code
    code = _STATUS_CODES.get(status, "internal_error" if status >= 500 else "invalid_request")
    if status in (404, 405) or not isinstance(exc.detail, str):
        message = _STATUS_MESSAGES.get(status, "The request could not be processed.")
    else:
        message = exc.detail
    response = error_response(status, code, message)
    if exc.headers:
        response.headers.update(exc.headers)
    return response


def install_middleware(app: FastAPI, settings: Settings) -> None:
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)  # type: ignore[arg-type]

    # add_middleware puts each new layer outside the previous ones: innermost first.
    app.add_middleware(BodyLimitMiddleware, settings=settings)
    app.add_middleware(CsrfMiddleware, settings=settings)
    origins = [origin.rstrip("/") for origin in settings.cors_origins if origin.strip() != "*"]
    if len(origins) != len(settings.cors_origins):
        log.warning("ignoring wildcard CORS origin: credentials are never shared with '*'")
    if origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
            allow_headers=["Content-Type", "Authorization", "X-PassagePort-CSRF"],
            max_age=600,
        )
    if settings.auth_mode == "local":
        app.add_middleware(HostGuardMiddleware, settings=settings)
    app.add_middleware(SecurityHeadersMiddleware, settings=settings)
