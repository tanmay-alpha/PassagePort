import { useMemo, useSyncExternalStore } from 'react'

import { errorMessage, isApiError, uploadDocument } from '@/api/client'
import type { LimitsOut, UploadOut } from '@/api/types'

import { fileExtension, formatBytes } from './format'

export type UploadStatus =
  | 'queued'
  | 'uploading'
  /** Stored as a new document; indexing has started. */
  | 'done'
  /** The same bytes already exist in the workspace; nothing was stored. */
  | 'duplicate'
  /** The server refused or the transfer failed; `message` says why. */
  | 'failed'
  /** Stopped by a client-side check before any bytes were sent. */
  | 'rejected'
  | 'cancelled'

export interface UploadItem {
  id: number
  collectionId: string
  name: string
  size: number
  status: UploadStatus
  /** Bytes the browser reports as sent. */
  loaded: number
  /** Request size as measured by the browser; null until/unless it can be measured. */
  total: number | null
  message: string | null
  documentTitle: string | null
}

const CONCURRENCY = 2

/**
 * Module-level queue so uploads keep going (and stay visible) while the user moves between
 * screens. At most CONCURRENCY requests run at once; each sends one file, as the API expects.
 */
let items: UploadItem[] = []
let nextId = 1
let running = 0
const pending: Array<{ id: number; file: File; onStored: (result: UploadOut) => void }> = []
const aborts = new Map<number, () => void>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function patch(id: number, changes: Partial<UploadItem>): void {
  items = items.map((item) => (item.id === id ? { ...item, ...changes } : item))
  emit()
}

/** The reason a file cannot be uploaded, checked against the server's published limits. */
export function rejectionReason(file: Pick<File, 'name' | 'size'>, limits: LimitsOut): string | null {
  const allowed = limits.allowed_extensions.map((extension) => extension.replace(/^\./, '').toLowerCase())
  if (!allowed.includes(fileExtension(file.name))) {
    return `Unsupported file type. Allowed: ${allowed.map((extension) => `.${extension}`).join(', ')}.`
  }
  if (file.size === 0) return 'The file is empty.'
  if (file.size > limits.max_upload_bytes) {
    return `${formatBytes(file.size)} is over the ${formatBytes(limits.max_upload_bytes)} limit per file.`
  }
  return null
}

function pump(): void {
  while (running < CONCURRENCY) {
    const next = pending.shift()
    if (!next) return
    const item = items.find((candidate) => candidate.id === next.id)
    if (!item || item.status !== 'queued') continue
    running += 1
    patch(next.id, { status: 'uploading' })
    const handle = uploadDocument(item.collectionId, next.file, ({ loaded, total }) => patch(next.id, { loaded, total }))
    aborts.set(next.id, handle.abort)
    handle.promise
      .then(
        (result) => {
          patch(next.id, {
            status: result.duplicate ? 'duplicate' : 'done',
            documentTitle: result.document.title,
            message: null,
          })
          next.onStored(result)
        },
        (error: unknown) => {
          const cancelled = isApiError(error, 'aborted')
          patch(next.id, {
            status: cancelled ? 'cancelled' : 'failed',
            message: cancelled ? null : errorMessage(error, 'The upload failed.'),
          })
        },
      )
      .finally(() => {
        aborts.delete(next.id)
        running -= 1
        pump()
      })
  }
}

/** Adds files to the queue. `onStored` runs after each file the server accepted. */
export function enqueueUploads(
  collectionId: string,
  files: readonly File[],
  limits: LimitsOut,
  onStored: (result: UploadOut) => void,
): void {
  const added: UploadItem[] = []
  for (const file of files) {
    const reason = rejectionReason(file, limits)
    const id = nextId++
    added.push({
      id,
      collectionId,
      name: file.name,
      size: file.size,
      status: reason ? 'rejected' : 'queued',
      loaded: 0,
      total: null,
      message: reason,
      documentTitle: null,
    })
    if (!reason) pending.push({ id, file, onStored })
  }
  items = [...items, ...added]
  emit()
  pump()
}

export function cancelUpload(id: number): void {
  const abort = aborts.get(id)
  if (abort) abort()
  else patch(id, { status: 'cancelled' })
}

export function isActiveUpload(item: UploadItem): boolean {
  return item.status === 'queued' || item.status === 'uploading'
}

/** Removes finished entries of one workspace from the list. */
export function clearFinishedUploads(collectionId: string): void {
  items = items.filter((item) => item.collectionId !== collectionId || isActiveUpload(item))
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useUploads(collectionId: string): UploadItem[] {
  const all = useSyncExternalStore(
    subscribe,
    () => items,
    () => items,
  )
  return useMemo(() => all.filter((item) => item.collectionId === collectionId), [all, collectionId])
}
