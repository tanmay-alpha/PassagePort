"""API error type. Rendered as ``{"error": {"code": ..., "message": ...}}``."""

from __future__ import annotations


class ApiError(Exception):
    def __init__(self, status_code: int, code: str, message: str, **extra: object) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.extra = extra


def not_found(what: str = "Resource") -> ApiError:
    # Used for both "does not exist" and "belongs to someone else": never reveal which.
    return ApiError(404, "not_found", f"{what} not found.")
