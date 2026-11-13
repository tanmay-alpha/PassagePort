"""Collection CRUD.

Mutations run in an explicit transaction that is committed before the handler returns, so a
client that reacts to the response always reads its own write, and files are only removed from
blob storage once the rows that referenced them are gone for good.
"""

from __future__ import annotations

import contextlib

from fastapi import APIRouter, Response
from sqlalchemy import Row

from passageport.api.deps import Conn, CurrentUser, EngineDep, SettingsDep
from passageport.api.schemas import CollectionIn, CollectionOut, CollectionPatch
from passageport.db import repos
from passageport.errors import ApiError
from passageport.storage.blobs import get_blob_store
from passageport.storage.validate import clean_text

router = APIRouter(prefix="/api", tags=["collections"])


def _collection_out(row: Row) -> CollectionOut:
    return CollectionOut(
        id=row.id,
        name=row.name,
        description=row.description,
        created_at=row.created_at,
        updated_at=row.updated_at,
        document_count=int(row.document_count),
        indexed_count=int(row.indexed_count),
        processing_count=int(row.processing_count),
        failed_count=int(row.failed_count),
        chunk_count=int(row.chunk_count),
        size_bytes=int(row.size_bytes),
    )


def _clean_name(name: str) -> str:
    cleaned = clean_text(name, 120)
    if not cleaned:
        raise ApiError(422, "invalid_request", "name: must contain visible characters")
    return cleaned


def _drop_cached_index(collection_id: str) -> None:
    """Let the search layer free the in-memory index of a deleted collection. Only a hint: cached
    indexes are keyed by ``index_version``, so correctness never depends on this call."""
    try:
        from passageport.search.index import invalidate  # noqa: PLC0415
    except ImportError:
        return
    with contextlib.suppress(Exception):
        invalidate(collection_id)


@router.get("/collections", response_model=list[CollectionOut])
def list_collections(conn: Conn, user: CurrentUser) -> list[CollectionOut]:
    return [_collection_out(row) for row in repos.list_collections(conn, user.id)]


@router.post("/collections", response_model=CollectionOut, status_code=201)
def create_collection(
    body: CollectionIn, user: CurrentUser, engine: EngineDep, settings: SettingsDep
) -> CollectionOut:
    with engine.begin() as conn:
        collection_id = repos.create_collection(
            conn,
            user.id,
            _clean_name(body.name),
            clean_text(body.description, 500),
            settings.max_collections_per_user,
        )
        return _collection_out(repos.get_collection(conn, user.id, collection_id))


@router.get("/collections/{collection_id}", response_model=CollectionOut)
def get_collection(collection_id: str, conn: Conn, user: CurrentUser) -> CollectionOut:
    return _collection_out(repos.get_collection(conn, user.id, collection_id))


@router.patch("/collections/{collection_id}", response_model=CollectionOut)
def update_collection(
    collection_id: str, body: CollectionPatch, user: CurrentUser, engine: EngineDep
) -> CollectionOut:
    with engine.begin() as conn:
        repos.update_collection(
            conn,
            user.id,
            collection_id,
            _clean_name(body.name) if body.name is not None else None,
            clean_text(body.description, 500) if body.description is not None else None,
        )
        return _collection_out(repos.get_collection(conn, user.id, collection_id))


@router.delete("/collections/{collection_id}", status_code=204)
def delete_collection(
    collection_id: str, user: CurrentUser, engine: EngineDep, settings: SettingsDep
) -> Response:
    """Delete the collection with its documents, pages, chunks and stored files."""
    store = get_blob_store(settings, engine)
    with engine.begin() as conn:
        blob_keys = repos.delete_collection(conn, user.id, collection_id)
        store.remove_in_transaction(conn, blob_keys)
    store.remove_files(blob_keys)
    _drop_cached_index(collection_id)
    return Response(status_code=204)
