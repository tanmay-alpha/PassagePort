"""Per-user sliding-window rate limit for the compute-heavy endpoints.

In-memory and per-process: it bounds what one account can ask of one instance. It is a resource
guard, not an abuse-proof quota.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

from passageport.api.deps import CurrentUser, SettingsDep
from passageport.errors import ApiError

_WINDOW_SECONDS = 60.0
_lock = threading.Lock()
_calls: dict[str, deque[float]] = defaultdict(deque)


def rate_limit(user: CurrentUser, settings: SettingsDep) -> None:
    limit = settings.rate_limit_per_minute
    if limit <= 0:
        return
    now = time.monotonic()
    with _lock:
        window = _calls[user.id]
        while window and now - window[0] > _WINDOW_SECONDS:
            window.popleft()
        if len(window) >= limit:
            raise ApiError(429, "rate_limited", "Too many requests. Wait a moment and try again.")
        window.append(now)


def reset_rate_limits() -> None:
    with _lock:
        _calls.clear()
