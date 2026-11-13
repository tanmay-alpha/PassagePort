"""Upload validation: size cap, file-name sanitising and content sniffing.

Nothing a client sends is trusted: the declared content type is ignored, the extension only
selects which signature the bytes must match, and the file name is reduced to a display string
that is never used as a path.
"""

from __future__ import annotations

import io
import os
import unicodedata
import zipfile
from dataclasses import dataclass
from typing import BinaryIO

from passageport.config import ALLOWED_EXTENSIONS
from passageport.errors import ApiError

MAX_FILENAME_CHARS = 200
MAX_TITLE_CHARS = 255
# DOCX is a zip archive. These caps are checked against the central directory before any entry
# is decompressed, so a zip bomb is rejected without inflating a single byte.
MAX_ZIP_ENTRIES = 2000
MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
_ZIP_CENTRAL_HEADER = b"PK\x01\x02"
_READ_CHUNK = 1024 * 1024
_SUPPORTED = "PDF, DOCX, TXT or Markdown"


@dataclass(frozen=True, slots=True)
class ValidatedUpload:
    filename: str  # sanitized display name
    title: str  # default title: the file name without its extension
    kind: str  # pdf | txt | md | docx
    data: bytes


def unsupported(message: str) -> ApiError:
    return ApiError(415, "unsupported_file", message)


# Bidirectional overrides can make "exe.fdp" display as "pdf.exe"; they have no place in a name.
_BIDI_CONTROLS = frozenset("\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200e\u200f")


def clean_text(value: str, max_chars: int) -> str:
    """Single-line display text: no control characters (NUL breaks PostgreSQL text columns), no
    bidi overrides, whitespace collapsed, bounded length."""
    kept = "".join(
        " " if ch.isspace() else ch
        for ch in value
        if ch.isspace()
        or (unicodedata.category(ch) not in {"Cc", "Cs", "Co", "Cn"} and ch not in _BIDI_CONTROLS)
    )
    return " ".join(kept.split())[:max_chars].strip()


def sanitize_filename(raw: str | None) -> str:
    """Basename only, no control characters or separators, bounded length, extension preserved."""
    name = unicodedata.normalize("NFC", raw or "")
    name = name.replace("\\", "/").rsplit("/", 1)[-1]
    name = clean_text(name, 4096).rstrip(". ")
    if len(name) > MAX_FILENAME_CHARS:
        stem, ext = os.path.splitext(name)
        ext = ext[:16]
        name = stem[: MAX_FILENAME_CHARS - len(ext)].rstrip(". ") + ext
    return name


def read_limited(stream: BinaryIO, max_bytes: int) -> bytes:
    """Read the upload in bounded chunks and stop as soon as it exceeds the limit."""
    parts: list[bytes] = []
    total = 0
    while chunk := stream.read(_READ_CHUNK):
        total += len(chunk)
        if total > max_bytes:
            raise ApiError(
                413,
                "payload_too_large",
                f"The file is larger than the {format_megabytes(max_bytes)} upload limit.",
            )
        parts.append(chunk)
    return b"".join(parts)


def format_megabytes(size: int) -> str:
    return f"{round(size / (1024 * 1024), 2):g} MB"


def _check_pdf(data: bytes) -> None:
    if not data.startswith(b"%PDF-"):
        raise unsupported("This file has a .pdf extension but is not a PDF document.")


def _check_text(data: bytes, label: str) -> None:
    if b"\x00" in data:
        raise unsupported(f"This {label} file contains binary data. Only plain UTF-8 text is supported.")
    try:
        data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise unsupported(
            f"This {label} file is not valid UTF-8 text. Save it with UTF-8 encoding and upload it again."
        ) from None


def _check_docx(data: bytes) -> None:
    not_docx = unsupported("This file has a .docx extension but is not a Word document.")
    too_big = unsupported("This Word document expands to an unreasonable size and was rejected for safety.")
    # Opening a zip builds one object per central-directory entry, so a small file with hundreds
    # of thousands of empty entries would cost the server far more memory than its size. Every
    # entry record must start with this signature, so counting it bounds what any zip parser can
    # materialise - without trusting a single length or count field of the archive.
    if data.count(_ZIP_CENTRAL_HEADER) > MAX_ZIP_ENTRIES:
        raise too_big
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
    except (zipfile.BadZipFile, zipfile.LargeZipFile, ValueError, OSError, NotImplementedError):
        raise not_docx from None
    if len(entries) > MAX_ZIP_ENTRIES or sum(e.file_size for e in entries) > MAX_ZIP_UNCOMPRESSED_BYTES:
        raise too_big
    if "word/document.xml" not in {e.filename for e in entries}:
        raise not_docx


def validate_upload(raw_filename: str | None, data: bytes) -> ValidatedUpload:
    """Check the extension allowlist and that the bytes really are what the extension claims."""
    filename = sanitize_filename(raw_filename)
    extension = os.path.splitext(filename)[1].lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise unsupported(f"Unsupported file type. Upload a {_SUPPORTED} file.")
    if not data:
        raise ApiError(422, "invalid_request", "The file is empty.")
    kind = extension[1:]
    if kind == "pdf":
        _check_pdf(data)
    elif kind == "docx":
        _check_docx(data)
    else:
        _check_text(data, "Markdown" if kind == "md" else "text")
    title = clean_text(os.path.splitext(filename)[0], MAX_TITLE_CHARS) or "Untitled"
    return ValidatedUpload(filename=filename, title=title, kind=kind, data=data)
