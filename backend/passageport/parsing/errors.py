"""Errors raised while turning an uploaded file into text."""

from __future__ import annotations


class ParseError(Exception):
    """A document could not be parsed. ``user_message`` is safe to show to the uploader: it never
    contains file content, paths or library internals."""

    def __init__(self, user_message: str) -> None:
        super().__init__(user_message)
        self.user_message = user_message
