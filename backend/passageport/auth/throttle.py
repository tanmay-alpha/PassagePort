"""In-memory sliding-window throttles for credential endpoints.

Per-process state: this slows down online password guessing against one instance. It is not a
distributed lockout, and a deliberate trade-off applies: hammering one username blocks sign-in to
that account from everywhere for the rest of the window.
"""

from __future__ import annotations

import contextlib
import threading
import time
from collections import deque

from passageport.errors import ApiError

_MAX_TRACKED_KEYS = 20_000


class Throttle:
    def __init__(self, limit: int, window_seconds: float, message: str) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self._message = message
        self._lock = threading.Lock()
        self._events: dict[str, deque[float]] = {}

    def _prune(self, key: str, now: float) -> deque[float] | None:
        window = self._events.get(key)
        if window is None:
            return None
        while window and now - window[0] > self.window_seconds:
            window.popleft()
        if not window:
            del self._events[key]
            return None
        return window

    def reserve(self, *keys: str) -> float:
        """Atomically check every key and record one attempt against each.

        Check and record happen under one lock, so a burst of simultaneous requests cannot all
        pass the check before the first of them is counted: at most ``limit`` callers per window
        get past this point (and on to the expensive password hash). Raises 429 otherwise.
        Returns a ticket for ``release``.
        """
        now = time.monotonic()
        with self._lock:
            if len(self._events) > _MAX_TRACKED_KEYS:
                for stale in list(self._events):
                    self._prune(stale, now)
            for key in keys:
                window = self._prune(key, now)
                if window is not None and len(window) >= self.limit:
                    raise ApiError(429, "rate_limited", self._message)
            for key in keys:
                self._events.setdefault(key, deque()).append(now)
        return now

    def release(self, ticket: float, *keys: str) -> None:
        """Give back a reservation that turned out not to be a failed attempt."""
        with self._lock:
            for key in keys:
                window = self._events.get(key)
                if window is None:
                    continue
                with contextlib.suppress(ValueError):
                    window.remove(ticket)
                if not window:
                    del self._events[key]

    def reset(self, *keys: str) -> None:
        """Forget the given keys, or everything when called without arguments."""
        with self._lock:
            if not keys:
                self._events.clear()
            for key in keys:
                self._events.pop(key, None)


# Sign-in attempts that did not succeed, counted per username and per client address.
login_throttle = Throttle(8, 300.0, "Too many sign-in attempts. Wait a few minutes and try again.")
# Account creation (sign-up and guest), counted per client address.
signup_throttle = Throttle(10, 600.0, "Too many accounts created from this address. Try again later.")


def reset_throttles() -> None:
    login_throttle.reset()
    signup_throttle.reset()
