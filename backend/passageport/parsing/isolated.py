"""Run a parser in a killable child process.

Document parsers are large pieces of third-party code fed attacker-controlled bytes. A file that
makes one loop forever or allocate without bound must cost one child process, not the server. The
child is started with the ``spawn`` method (identical behaviour on Windows, macOS and Linux, and no
forked copy of the server's memory or database connections), gets a hard deadline, and on POSIX
also an address-space limit.
"""

from __future__ import annotations

import contextlib
import logging
import multiprocessing
import sys
from collections.abc import Callable
from multiprocessing.connection import Connection
from typing import Any

from passageport.parsing.errors import ParseError

MEMORY_LIMIT_BYTES = 1536 * 1024 * 1024

TIMEOUT_MESSAGE = (
    "Reading this document took too long and was stopped. The file may be damaged or too complex."
)
CRASH_MESSAGE = "This document could not be processed. The file may be damaged or too complex to read."
MEMORY_MESSAGE = "This document needs too much memory to process. Split it into smaller files."


def _limit_memory() -> None:
    """Cap the child's address space where the platform supports it (not on Windows)."""
    if sys.platform == "win32":
        return
    try:
        import resource
    except ImportError:
        return
    with contextlib.suppress(ValueError, OSError):
        _soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        limit = MEMORY_LIMIT_BYTES if hard == resource.RLIM_INFINITY else min(MEMORY_LIMIT_BYTES, hard)
        resource.setrlimit(resource.RLIMIT_AS, (limit, hard))


def _child_main(func: Callable[..., Any], args: tuple[Any, ...], channel: Connection) -> None:
    # Parser warnings can quote file content; nothing from the child may reach the server log.
    logging.disable(logging.CRITICAL)
    _limit_memory()
    try:
        message: tuple[str, Any] = ("ok", func(*args))
    except ParseError as exc:
        message = ("parse_error", exc.user_message)
    except MemoryError:
        message = ("parse_error", MEMORY_MESSAGE)
    except BaseException as exc:  # report the type only, never the message
        message = ("crash", type(exc).__name__)
    try:
        channel.send(message)
    finally:
        channel.close()


def run_isolated(func: Callable[..., Any], args: tuple[Any, ...], timeout_seconds: float) -> Any:
    """Call ``func(*args)`` in a fresh child process and return its result.

    ``func`` must be importable (module-level) and its arguments and result picklable. Raises
    ``ParseError`` with a user-safe message when the child reports one, exceeds the deadline, or
    dies without answering.
    """
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=_child_main, args=(func, args, sender), daemon=True)
    process.start()
    sender.close()  # the child holds the only write end now, so its death shows up as EOF
    try:
        if not receiver.poll(timeout_seconds):
            raise ParseError(TIMEOUT_MESSAGE)
        try:
            status, payload = receiver.recv()
        except (EOFError, OSError):
            raise ParseError(CRASH_MESSAGE) from None
    finally:
        receiver.close()
        if process.is_alive():
            process.kill()
        process.join(timeout=10)
        with contextlib.suppress(ValueError):
            process.close()
    if status == "ok":
        return payload
    if status == "parse_error":
        raise ParseError(str(payload))
    logging.getLogger("passageport.parsing").warning("parser failed in child process: %s", payload)
    raise ParseError(CRASH_MESSAGE)
