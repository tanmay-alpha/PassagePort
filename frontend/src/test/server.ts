import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

import { makeCollection, makeDocument, makeSession, makeSystem } from './fixtures'

/** The error envelope every API failure uses. */
export function apiError(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status })
}

/**
 * Baseline: local mode, one workspace, one indexed Markdown document. Tests replace individual
 * endpoints with `server.use(...)`; anything not mocked fails the test (onUnhandledRequest).
 */
export const defaultHandlers = [
  http.get('/api/health', () => HttpResponse.json({ status: 'ok' })),
  http.get('/api/session', () => HttpResponse.json(makeSession())),
  http.get('/api/system', () => HttpResponse.json(makeSystem())),
  http.get('/api/collections', () => HttpResponse.json([makeCollection()])),
  http.get('/api/collections/:collectionId/documents', () => HttpResponse.json([makeDocument()])),
  http.get('/api/documents/:documentId', ({ params }) => HttpResponse.json(makeDocument({ id: String(params.documentId) }))),
  http.get('/api/lab/evaluation', () => apiError(404, 'not_found', 'Evaluation report not found.')),
]

export const server = setupServer(...defaultHandlers)
