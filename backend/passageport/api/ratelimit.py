"""Per-user sliding-window rate limit for the compute-heavy endpoints.

In-memory and per-process: it bounds what one account can ask of one instance. It is a resource
guard, not an abuse-proof quota.
"""

from __future__ import annotations

import threading
import time
from collections import deque

from passageport.api.deps import CurrentUser, SettingsDep
from passageport.errors import ApiError

_WINDOW_SECONDS = 60.0
# Users whose window has emptied are forgotten once this many are tracked, so a stream of
# short-lived guest accounts cannot grow the table without bound.
_MAX_TRACKED_USERS = 10_000
_lock = threading.Lock()
_calls: dict[str, deque[float]] = {}


def _forget_idle(now: float) -> None:
    for user_id, window in list(_calls.items()):
        if not window or now - window[-1] > _WINDOW_SECONDS:
            del _calls[user_id]


def rate_limit(user: CurrentUser, settings: SettingsDep) -> None:
    limit = settings.rate_limit_per_minute
    if limit <= 0:
        return
    now = time.monotonic()
    with _lock:
        if len(_calls) >= _MAX_TRACKED_USERS and user.id not in _calls:
            _forget_idle(now)
        window = _calls.setdefault(user.id, deque())
        while window and now - window[0] > _WINDOW_SECONDS:
            window.popleft()
        if len(window) >= limit:
            raise ApiError(429, "rate_limited", "Too many requests. Wait a moment and try again.")
        window.append(now)


def reset_rate_limits() -> None:
    with _lock:
        _calls.clear()
