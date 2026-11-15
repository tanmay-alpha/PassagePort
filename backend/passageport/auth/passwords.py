"""Password hashing with argon2id (argon2-cffi defaults: the RFC 9106 low-memory profile)."""

from __future__ import annotations

import secrets
import threading
from functools import lru_cache

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_hasher = PasswordHasher()

# Every argon2 computation allocates memory_cost (64 MiB with the defaults). Sign-in and sign-up run
# in the server's thread pool (40 threads), so a burst of simultaneous attempts from a handful of
# addresses - each still inside its throttle - could otherwise need gigabytes at once and get the
# process killed. Excess attempts wait for a slot instead.
MAX_CONCURRENT_HASHES = 2
_slots = threading.BoundedSemaphore(MAX_CONCURRENT_HASHES)


def hash_password(password: str) -> str:
    with _slots:
        return _hasher.hash(password)


@lru_cache(maxsize=1)
def _dummy_hash() -> str:
    """A hash nobody knows the password of, with the current parameters."""
    return _hasher.hash(secrets.token_urlsafe(32))


def verify_password(stored_hash: str | None, password: str) -> bool:
    """Check a password against a stored hash.

    When there is no hash (unknown user, or an account without a password) a dummy hash is
    verified instead, so the response takes as long as for a real account and cannot be used to
    find out which usernames exist.
    """
    with _slots:
        try:
            _hasher.verify(stored_hash or _dummy_hash(), password)
        except (VerificationError, InvalidHashError):
            return False
    return stored_hash is not None


def needs_rehash(stored_hash: str) -> bool:
    return _hasher.check_needs_rehash(stored_hash)
