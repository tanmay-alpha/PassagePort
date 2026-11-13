"""Documents: upload, list, read, rename, delete, re-index, original file, page text, citations.

Every lookup is scoped to the signed-in user in SQL; another user's id answers exactly like an id
that does not exist. Mutations commit before the handler returns (explicit transactions), so the
worker is only woken for jobs it can actually see and blobs are only deleted after their rows.
"""

from __future__ import annotations

import hashlib
from typing import Annotated, cast, get_args
from urllib.parse import quote

from fastapi import APIRouter, File, Path, Response, UploadFile
from sqlalchemy import Row
from sqlalchemy.exc import IntegrityError

from passageport.api.deps import Conn, CurrentUser, EngineDep, SettingsDep
from passageport.api.schemas import (
    ChunkOut,
    DocumentKind,
    DocumentOut,
    DocumentPatch,
    DocumentStatus,
    LocatorKind,
    OutlineItem,
    OutlineOut,
    PageOut,
    UploadOut,
)
from passageport.chunking import chunker_version
from passageport.config import Settings
from passageport.db import repos
from passageport.db.access import get_chunk_for_user, require_collection
from passageport.domain import locator_kind
from passageport.errors import ApiError, not_found
from passageport.ingest.worker import enqueue, notify
from passageport.ml.registry import get_embedder, models_loaded
from passageport.storage.blobs import BlobNotFoundError, get_blob_store, new_blob_key
from passageport.storage.validate import clean_text, format_megabytes, read_limited, validate_upload

router = APIRouter(prefix="/api", tags=["documents"])

# Served content types are fixed per kind: nothing the uploader declared is ever echoed back.
_CONTENT_TYPES = {
    "pdf": "application/pdf",
    "txt": "text/plain; charset=utf-8",
    "md": "text/markdown; charset=utf-8",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
_STATUSES: tuple[str, ...] = get_args(DocumentStatus)


def _locator(kind: str) -> LocatorKind:
    return cast("LocatorKind", locator_kind(kind))


def embedding_is_current(settings: Settings, stored_version: str | None) -> bool:
    """Was a document embedded with the model the server is configured to use?

    Embedder versions look like ``"{backend}:{model}:{dimensions}"``. Dimensions are only known
    after the model has been loaded, and listing documents must not trigger a model download, so
    until then only the ``backend:model`` prefix is compared.
    """
    if not stored_version:
        return False
    if models_loaded()["embedder"] or settings.embedding_backend == "hashing":
        return stored_version == get_embedder().version
    return stored_version.startswith(f"{settings.embedding_backend}:{settings.embedding_model}:")


def is_stale(row: Row, settings: Settings) -> bool:
    return row.status == "indexed" and not (
        embedding_is_current(settings, row.embedding_version)
        and row.chunker_version == chunker_version(settings)
    )


def document_out(row: Row, settings: Settings) -> DocumentOut:
    return DocumentOut(
        id=row.id,
        collection_id=row.collection_id,
        title=row.title,
        filename=row.filename,
        kind=row.kind,
        locator_kind=_locator(row.kind),
        size_bytes=row.size_bytes,
        sha256=row.sha256,
        status=row.status,
        error=row.error,
        page_count=row.page_count,
        chunk_count=row.chunk_count,
        stale=is_stale(row, settings),
        created_at=row.created_at,
        updated_at=row.updated_at,
        indexed_at=row.indexed_at,
    )


def _check_quota(usage: repos.Usage, new_bytes: int, settings: Settings) -> None:
    if usage.documents >= settings.max_documents_per_user:
        raise ApiError(
            409,
            "quota_exceeded",
            f"You have reached the limit of {settings.max_documents_per_user} documents. "
            "Delete documents you no longer need to upload more.",
        )
    limit = settings.max_storage_mb_per_user * 1024 * 1024
    if usage.storage_bytes + new_bytes > limit:
        raise ApiError(
            409,
            "quota_exceeded",
            f"This upload would exceed your {format_megabytes(limit)} storage limit. "
            "Delete documents you no longer need to free space.",
        )


# --------------------------------------------------------------------------- collection-scoped


@router.get("/collections/{collection_id}/documents", response_model=list[DocumentOut])
def list_documents(
    *,
    collection_id: str,
    conn: Conn,
    user: CurrentUser,
    settings: SettingsDep,
    status: str | None = None,
    q: str | None = None,
) -> list[DocumentOut]:
    """Documents of a collection, newest first. ``status`` filters by indexing state and ``q``
    matches title or file name, case-insensitively."""
    require_collection(conn, user, collection_id)
    if status and status not in _STATUSES:
        raise ApiError(422, "invalid_request", f"status: must be one of {', '.join(_STATUSES)}")
    needle = (q or "").strip()[:200]
    rows = repos.list_documents(conn, user.id, collection_id, status or None, needle or None)
    return [document_out(row, settings) for row in rows]


@router.post(
    "/collections/{collection_id}/documents",
    response_model=UploadOut,
    status_code=201,
    responses={200: {"model": UploadOut, "description": "The same file already exists in the collection."}},
)
def upload_document(
    *,
    collection_id: str,
    response: Response,
    user: CurrentUser,
    engine: EngineDep,
    settings: SettingsDep,
    file: UploadFile = File(...),
) -> UploadOut:
    """Store one file and queue it for indexing."""
    with engine.connect() as conn:
        require_collection(conn, user, collection_id)  # 404 before any work is spent on the body
    data = read_limited(file.file, settings.max_upload_bytes)
    upload = validate_upload(file.filename, data)
    sha256 = hashlib.sha256(data).hexdigest()
    store = get_blob_store(settings, engine)

    blob_key: str | None = None
    duplicate = False
    try:
        with engine.begin() as conn:
            # One upload per user at a time from here on, so the duplicate and quota checks below
            # cannot be outrun by a concurrent request.
            repos.lock_user(conn, user.id)
            require_collection(conn, user, collection_id)
            row = repos.find_by_hash(conn, collection_id, sha256)
            if row is not None:
                duplicate = True
            else:
                _check_quota(repos.user_usage(conn, user.id), len(data), settings)
                blob_key = new_blob_key()
                store.put(blob_key, data, conn)
                document_id = repos.insert_document(
                    conn,
                    owner_id=user.id,
                    collection_id=collection_id,
                    title=upload.title,
                    filename=upload.filename,
                    kind=upload.kind,
                    size_bytes=len(data),
                    sha256=sha256,
                    blob_key=blob_key,
                )
                enqueue(conn, document_id)
                row = repos.get_document(conn, user.id, document_id)
    except IntegrityError:
        # The collection was deleted, or the same bytes were added to it, while this ran.
        if blob_key is not None:
            store.remove_files([blob_key])
        with engine.connect() as conn:
            row = repos.find_by_hash(conn, collection_id, sha256)
        if row is None or row.owner_id != user.id:
            raise ApiError(409, "conflict", "The upload conflicted with another change. Try again.") from None
        duplicate = True
    except BaseException:
        if blob_key is not None:
            store.remove_files([blob_key])
        raise

    if duplicate:
        response.status_code = 200
    else:
        notify()
    return UploadOut(document=document_out(row, settings), duplicate=duplicate)


# --------------------------------------------------------------------------- single document


@router.get("/documents/{document_id}", response_model=DocumentOut)
def get_document(document_id: str, conn: Conn, user: CurrentUser, settings: SettingsDep) -> DocumentOut:
    return document_out(repos.get_document(conn, user.id, document_id), settings)


@router.patch("/documents/{document_id}", response_model=DocumentOut)
def rename_document(
    document_id: str, body: DocumentPatch, user: CurrentUser, engine: EngineDep, settings: SettingsDep
) -> DocumentOut:
    title = clean_text(body.title, 255)
    if not title:
        raise ApiError(422, "invalid_request", "title: must contain visible characters")
    with engine.begin() as conn:
        repos.rename_document(conn, user.id, document_id, title)
        return document_out(repos.get_document(conn, user.id, document_id), settings)


@router.delete("/documents/{document_id}", status_code=204)
def delete_document(
    document_id: str, user: CurrentUser, engine: EngineDep, settings: SettingsDep
) -> Response:
    """Delete the document, its pages and chunks, and the stored file."""
    store = get_blob_store(settings, engine)
    with engine.begin() as conn:
        row = repos.delete_document(conn, user.id, document_id)
        store.remove_in_transaction(conn, [row.blob_key])
    store.remove_files([row.blob_key])
    return Response(status_code=204)


@router.post("/documents/{document_id}/reindex", response_model=DocumentOut, status_code=202)
def reindex_document(
    document_id: str, user: CurrentUser, engine: EngineDep, settings: SettingsDep
) -> DocumentOut:
    """Queue a fresh indexing run. The current index keeps serving searches until the new one is
    ready, and stays in place if the run fails."""
    with engine.begin() as conn:
        repos.mark_for_reindex(conn, user.id, document_id)
        enqueue(conn, document_id)
        out = document_out(repos.get_document(conn, user.id, document_id), settings)
    notify()
    return out


def _content_disposition(kind: str, filename: str) -> str:
    """RFC 6266 header with an ASCII fallback and an RFC 5987 encoded UTF-8 name."""
    disposition = "inline" if kind == "pdf" else "attachment"
    fallback = "".join(
        ch if ch.isascii() and ch.isprintable() and ch not in '"\\;' else "_" for ch in filename
    )
    return (
        f"{disposition}; filename=\"{fallback or 'document'}\"; filename*=UTF-8''{quote(filename, safe='')}"
    )


@router.get("/documents/{document_id}/file", response_class=Response)
def download_file(
    document_id: str, conn: Conn, user: CurrentUser, engine: EngineDep, settings: SettingsDep
) -> Response:
    """The original uploaded bytes.

    Uploaded files are untrusted content served from the application's origin, so the response is
    sandboxed: fixed content type, no sniffing, and a CSP under which the file cannot run script
    or load anything even if a browser were to render it.
    """
    row = repos.get_document(conn, user.id, document_id)
    try:
        data = get_blob_store(settings, engine).get(row.blob_key)
    except BlobNotFoundError:
        raise not_found("File") from None
    return Response(
        content=data,
        media_type=_CONTENT_TYPES[row.kind],
        headers={
            "Content-Disposition": _content_disposition(row.kind, row.filename),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "Cache-Control": "private, no-store",
        },
    )


@router.get("/documents/{document_id}/outline", response_model=OutlineOut)
def get_outline(document_id: str, conn: Conn, user: CurrentUser) -> OutlineOut:
    row = repos.get_document(conn, user.id, document_id)
    return OutlineOut(
        document_id=row.id,
        locator_kind=_locator(row.kind),
        items=[
            OutlineItem(page_number=page.page_number, page_label=page.label)
            for page in repos.list_outline(conn, row.id)
        ],
    )


@router.get("/documents/{document_id}/pages/{page_number}", response_model=PageOut)
def get_page(
    document_id: str,
    page_number: Annotated[int, Path(ge=1, le=10_000_000)],
    conn: Conn,
    user: CurrentUser,
) -> PageOut:
    row = repos.get_document(conn, user.id, document_id)
    page = repos.get_page(conn, row.id, page_number)
    return PageOut(
        document_id=row.id,
        page_number=page.page_number,
        page_label=page.label,
        page_count=row.page_count,
        text=page.text,
    )


# --------------------------------------------------------------------------- citations


@router.get("/chunks/{chunk_id}", response_model=ChunkOut)
def get_chunk(chunk_id: str, conn: Conn, user: CurrentUser) -> ChunkOut:
    """Resolve a citation to its passage and location."""
    chunk = get_chunk_for_user(conn, user, chunk_id)
    return ChunkOut(
        chunk_id=chunk.chunk_id,
        document_id=chunk.document_id,
        document_title=chunk.document_title,
        document_kind=cast("DocumentKind", chunk.document_kind),
        locator_kind=_locator(chunk.document_kind),
        page_number=chunk.page_number,
        page_label=chunk.page_label,
        char_start=chunk.char_start,
        char_end=chunk.char_end,
        text=chunk.text,
    )
