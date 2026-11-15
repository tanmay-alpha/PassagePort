import { reportReachability } from '@/lib/connectivity'

import type { ErrorResponse, UploadOut } from './types'

export const CSRF_HEADER = 'X-PassagePort-CSRF'
const API_ROOT = '/api'

/** An error the UI can show as-is: the server's message, or a plain one for transport failures. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }

  /** The request never produced an API response (offline, server down, proxy error). */
  get unreachable(): boolean {
    return this.code === 'network'
  }
}

export function isApiError(error: unknown, code?: string): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code)
}

export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  return error instanceof ApiError ? error.message : fallback
}

type UnauthorizedHandler = () => void
let unauthorizedHandler: UnauthorizedHandler | null = null

/** Called on 401 from any endpoint except the session/auth ones (accounts mode sign-out). */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler
}

const GATEWAY_STATUSES = new Set([502, 503, 504])
const NETWORK_MESSAGE = 'The server could not be reached. Check your connection and try again.'

function isErrorResponse(value: unknown): value is ErrorResponse {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false
  const { error } = value
  if (typeof error !== 'object' || error === null || !('code' in error) || !('message' in error)) return false
  return typeof error.code === 'string' && typeof error.message === 'string'
}

/** Turns a non-2xx status + body text into an ApiError, tolerating non-JSON proxy errors. */
export function toApiError(status: number, bodyText: string): ApiError {
  try {
    const parsed: unknown = JSON.parse(bodyText)
    if (isErrorResponse(parsed)) return new ApiError(status, parsed.error.code, parsed.error.message)
  } catch {
    // Not JSON: fall through to a generic message.
  }
  if (GATEWAY_STATUSES.has(status)) return new ApiError(status, 'network', NETWORK_MESSAGE)
  return new ApiError(status, 'unexpected_response', `The server returned an unexpected response (${status}).`)
}

function handleFailure(path: string, error: ApiError): void {
  reportReachability(!error.unreachable)
  const isAuthEndpoint = path === '/session' || path.startsWith('/auth/login') || path.startsWith('/auth/signup')
  if (error.status === 401 && !isAuthEndpoint) unauthorizedHandler?.()
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

/** JSON request against `/api`. Resolves to `undefined` for 204 responses. */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = { Accept: 'application/json' }
  let body: string | undefined
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  if (method !== 'GET') headers[CSRF_HEADER] = '1'

  let response: Response
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: options.signal,
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    reportReachability(false)
    throw new ApiError(0, 'network', NETWORK_MESSAGE)
  }

  if (!response.ok) {
    const error = toApiError(response.status, await response.text().catch(() => ''))
    handleFailure(path, error)
    throw error
  }
  reportReachability(true)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export interface UploadProgress {
  loaded: number
  /** Null when the browser cannot measure the request body; show an indeterminate state. */
  total: number | null
}

export interface UploadHandle {
  promise: Promise<UploadOut>
  abort: () => void
}

/**
 * Uploads one file as multipart field `file`. XMLHttpRequest is used because fetch cannot
 * report request-body progress; `onProgress` only fires with bytes the browser really sent.
 */
export function uploadDocument(
  collectionId: string,
  file: File,
  onProgress: (progress: UploadProgress) => void,
): UploadHandle {
  const xhr = new XMLHttpRequest()
  const path = `/collections/${encodeURIComponent(collectionId)}/documents`
  const { promise, resolve, reject } = Promise.withResolvers<UploadOut>()
  xhr.open('POST', `${API_ROOT}${path}`)
  xhr.setRequestHeader('Accept', 'application/json')
  xhr.setRequestHeader(CSRF_HEADER, '1')
  xhr.upload.onprogress = (event) => {
    onProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : null })
  }
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      reportReachability(true)
      try {
        resolve(JSON.parse(xhr.responseText) as UploadOut)
      } catch {
        reject(new ApiError(xhr.status, 'unexpected_response', 'The server returned an unexpected response.'))
      }
      return
    }
    const error = toApiError(xhr.status, xhr.responseText)
    handleFailure(path, error)
    reject(error)
  }
  xhr.onerror = () => {
    reportReachability(false)
    reject(new ApiError(0, 'network', NETWORK_MESSAGE))
  }
  xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled.'))
  const form = new FormData()
  form.append('file', file, file.name)
  xhr.send(form)
  return { promise, abort: () => xhr.abort() }
}

export function documentFileUrl(documentId: string): string {
  return `${API_ROOT}/documents/${encodeURIComponent(documentId)}/file`
}
