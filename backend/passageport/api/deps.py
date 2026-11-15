"""FastAPI dependencies shared by every router."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy import Connection, Engine

from passageport.config import Settings, get_settings
from passageport.domain import User


def get_engine(request: Request) -> Engine:
    return request.app.state.engine


def get_conn(request: Request) -> Iterator[Connection]:
    """One transaction per request: committed on success, rolled back on error."""
    with request.app.state.engine.begin() as conn:
        yield conn


def current_user(request: Request) -> User:
    """The authenticated user. Implemented in ``passageport.auth.service``.

    local mode: the single implicit user. accounts mode: session cookie or bearer API token;
    raises ApiError(401, "unauthenticated") otherwise.
    """
    from passageport.auth.service import authenticate_request

    return authenticate_request(request)


SettingsDep = Annotated[Settings, Depends(get_settings)]
EngineDep = Annotated[Engine, Depends(get_engine)]
Conn = Annotated[Connection, Depends(get_conn)]
CurrentUser = Annotated[User, Depends(current_user)]
