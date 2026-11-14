"""Application factory."""

from __future__ import annotations

import importlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from passageport import __version__
from passageport.api.middleware import install_middleware
from passageport.api.static import mount_frontend
from passageport.config import Settings, get_settings
from passageport.db.engine import create_db_engine
from passageport.errors import ApiError
from passageport.ingest.worker import start_worker, stop_worker

log = logging.getLogger("passageport")

# Router modules, each exposing ``router`` (an APIRouter whose paths start with /api).
ROUTERS = (
    "passageport.api.routes.system",
    "passageport.api.routes.auth",
    "passageport.api.routes.collections",
    "passageport.api.routes.documents",
    "passageport.api.routes.search",
    "passageport.api.routes.ask",
    "passageport.api.routes.compare",
    "passageport.api.routes.lab",
)


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        start_worker(app.state.engine, settings)
        yield
        stop_worker()
        app.state.engine.dispose()

    app = FastAPI(
        title="PassagePort API",
        version=__version__,
        description="Document workspace: hybrid retrieval, page-accurate citations, "
        "evidence-backed answers and document comparison.",
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.state.settings = settings
    app.state.engine = create_db_engine(settings)

    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return _error(exc.status_code, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
        message = f"{where}: {first.get('msg', 'invalid request')}" if where else "Invalid request."
        return _error(422, "invalid_request", message)

    @app.exception_handler(Exception)
    async def _unhandled(_request: Request, exc: Exception) -> JSONResponse:
        # Log the type only: exception messages can contain document text or paths.
        log.error("unhandled error: %s", type(exc).__name__)
        return _error(500, "internal_error", "Something went wrong on the server.")

    install_middleware(app, settings)

    for module_name in ROUTERS:
        app.include_router(importlib.import_module(module_name).router)

    mount_frontend(app, settings)
    return app
