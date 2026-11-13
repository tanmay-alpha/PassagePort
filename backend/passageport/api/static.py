"""Serve the built single-page frontend from the same origin as the API.

Any existing file below ``settings.static_dir`` is served at its path; every other non-API GET
gets ``index.html`` so client-side routes survive a reload. ``/api/*`` never falls back to HTML:
an unknown API path stays a JSON 404.
"""

from __future__ import annotations

import mimetypes
import re
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

from passageport.config import Settings
from passageport.errors import not_found

# Explicit types for what a Vite build contains: the platform's mimetypes registry is not
# reliable (Windows maps .js through the registry), and browsers refuse mistyped modules/wasm.
_MEDIA_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".map": "application/json",
    ".webmanifest": "application/manifest+json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
}
# Vite content-hashes the file names it emits ("index-C3x9aQ1b.js"); those never change.
_HASHED_NAME = re.compile(r"[-.][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$")
_IMMUTABLE = "public, max-age=31536000, immutable"
_SHORT_LIVED = "public, max-age=3600"
_REVALIDATE = "no-cache"


def resolve_static_file(root: Path, path: str) -> Path | None:
    """The file ``path`` refers to inside ``root``, or None.

    ``root`` must already be resolved. Rejects anything that is not a plain relative path made of
    ordinary segments (no ``..``, drive letters, backslashes, NULs or dot-files), then verifies
    the resolved location is still inside ``root`` so symlinks cannot lead out of it either.
    """
    if not path or any(ch in path for ch in ("\x00", "\\", ":")):
        return None
    segments = path.split("/")
    if any(not segment or segment.startswith(".") for segment in segments):
        return None
    try:
        candidate = root.joinpath(*segments).resolve()
        if not candidate.is_relative_to(root) or not candidate.is_file():
            return None
    except (OSError, ValueError):
        return None
    return candidate


def _media_type(path: Path) -> str:
    known = _MEDIA_TYPES.get(path.suffix.lower())
    return known or mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def mount_frontend(app: FastAPI, settings: Settings) -> None:
    """Register the catch-all frontend route. Must be called after every API router."""
    if settings.static_dir is None:
        return
    root = settings.static_dir.resolve()
    index = root / "index.html"
    if not index.is_file():
        return

    def serve_frontend(path: str) -> FileResponse:
        if path == "api" or path.startswith("api/"):
            raise not_found()
        target = resolve_static_file(root, path)
        if target is not None and target != index:
            hashed = path.startswith("assets/") and _HASHED_NAME.search(target.name) is not None
            return FileResponse(
                target,
                media_type=_media_type(target),
                headers={"Cache-Control": _IMMUTABLE if hashed else _SHORT_LIVED},
            )
        if path.startswith("assets/"):
            # A missing build artefact must be a 404, not an HTML page served as JavaScript.
            raise not_found()
        return FileResponse(index, media_type=_MEDIA_TYPES[".html"], headers={"Cache-Control": _REVALIDATE})

    app.add_api_route(
        "/{path:path}", serve_frontend, methods=["GET", "HEAD"], include_in_schema=False, response_model=None
    )
