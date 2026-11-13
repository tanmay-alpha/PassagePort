import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { CollectionOut } from '@/api/types'
import { makeCollection } from '@/test/fixtures'
import { renderApp } from '@/test/render'
import { apiError, server } from '@/test/server'

describe('first run', () => {
  it('explains the flow and creates the first workspace', async () => {
    const collections: CollectionOut[] = []
    let posted: { body: unknown; csrf: string | null } | null = null
    server.use(
      http.get('/api/collections', () => HttpResponse.json(collections)),
      http.post('/api/collections', async ({ request }) => {
        posted = { body: await request.json(), csrf: request.headers.get('X-PassagePort-CSRF') }
        const created = makeCollection({ id: 'c9', name: 'Research papers', description: '', document_count: 0, indexed_count: 0, failed_count: 0, chunk_count: 0, size_bytes: 0 })
        collections.push(created)
        return HttpResponse.json(created, { status: 201 })
      }),
      http.get('/api/collections/c9/documents', () => HttpResponse.json([])),
    )
    const { user, router } = renderApp('/')

    expect(await screen.findByRole('heading', { name: 'Welcome to PassagePort' })).toBeInTheDocument()
    for (const step of ['Create a workspace', 'Add documents', 'Search with citations']) {
      expect(screen.getByRole('heading', { name: step })).toBeInTheDocument()
    }

    await user.type(screen.getByLabelText('Name your first workspace'), 'Research papers')
    await user.click(screen.getByRole('button', { name: 'Create workspace' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Research papers' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/c/c9')
    expect(posted).toEqual({ body: { name: 'Research papers', description: '' }, csrf: '1' })
    expect(await screen.findByText('No documents yet')).toBeInTheDocument()
  })

  it('asks for a name instead of sending an empty one', async () => {
    let requests = 0
    server.use(
      http.get('/api/collections', () => HttpResponse.json([])),
      http.post('/api/collections', () => {
        requests += 1
        return apiError(422, 'invalid_request', 'name: too short')
      }),
    )
    const { user } = renderApp('/')

    await user.click(await screen.findByRole('button', { name: 'Create workspace' }))

    expect(await screen.findByText('Enter a name to continue.')).toBeInTheDocument()
    expect(requests).toBe(0)
  })

  it('shows the server message when the name is taken', async () => {
    server.use(
      http.get('/api/collections', () => HttpResponse.json([])),
      http.post('/api/collections', () => apiError(409, 'conflict', 'A workspace with this name already exists.')),
    )
    const { user } = renderApp('/')

    await user.type(await screen.findByLabelText('Name your first workspace'), 'Contracts')
    await user.click(screen.getByRole('button', { name: 'Create workspace' }))

    expect(await screen.findByText('A workspace with this name already exists.')).toBeInTheDocument()
  })
})

describe('dashboard', () => {
  it('shows the counts reported by the server', async () => {
    server.use(
      http.get('/api/collections', () =>
        HttpResponse.json([makeCollection({ document_count: 12, indexed_count: 9, processing_count: 2, failed_count: 1, chunk_count: 1204, size_bytes: 3 * 1024 * 1024 })]),
      ),
    )
    renderApp('/')

    const card = await screen.findByRole('article', { name: 'Contracts' })
    expect(within(card).getByText('12 documents')).toBeInTheDocument()
    expect(within(card).getByText('9 indexed')).toBeInTheDocument()
    expect(within(card).getByText('2 processing')).toBeInTheDocument()
    expect(within(card).getByText('1 failed')).toBeInTheDocument()
    expect(within(card).getByText(/1,204 passages · 3\.0 MB/)).toBeInTheDocument()

    const status = await screen.findByRole('region', { name: 'System status' })
    expect(within(status).getByText('BAAI/bge-small-en-v1.5')).toBeInTheDocument()
    expect(within(status).getByText('Extractive, no language model configured')).toBeInTheDocument()
  })

  it('names what will be removed before deleting a workspace', async () => {
    let collections = [makeCollection({ document_count: 3 })]
    let deleted: string | null = null
    server.use(
      http.get('/api/collections', () => HttpResponse.json(collections)),
      http.delete('/api/collections/:id', ({ params }) => {
        deleted = String(params.id)
        collections = []
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { user } = renderApp('/')

    await user.click(await screen.findByRole('button', { name: 'Actions for Contracts' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }))

    const dialog = await screen.findByRole('dialog', { name: 'Delete “Contracts”?' })
    expect(within(dialog).getByText(/permanently removes 3 documents, the uploaded files, their extracted text and the search index/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Delete workspace' }))

    await waitFor(() => expect(deleted).toBe('c1'))
    expect(await screen.findByRole('heading', { name: 'Welcome to PassagePort' })).toBeInTheDocument()
  })
})
