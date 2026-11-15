import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { CollectionOut, DocumentOut } from '@/api/types'
import { SAMPLE_FILES } from '@/lib/samples'
import { makeCollection, makeDocument } from '@/test/fixtures'
import { renderApp } from '@/test/render'
import { apiError, server } from '@/test/server'

function sampleDocument(name: string, index: number, status: DocumentOut['status']): DocumentOut {
  const pdf = name.endsWith('.pdf')
  return makeDocument({
    id: `s${index}`,
    collection_id: 'cs',
    title: name.replace(/\.\w+$/, ''),
    filename: name,
    kind: pdf ? 'pdf' : 'md',
    locator_kind: pdf ? 'page' : 'section',
    status,
  })
}

describe('one-click sample documents', () => {
  it('downloads the bundled samples, creates a workspace and uploads each file through the API', async () => {
    const collections: CollectionOut[] = []
    const documents: DocumentOut[] = []
    const fetched: string[] = []
    const uploaded: Array<{ name: string; body: string; csrf: string | null }> = []
    let created: unknown = null
    server.use(
      http.get('/samples/:name', ({ params }) => {
        fetched.push(String(params.name))
        return new HttpResponse(`bytes of ${String(params.name)}`)
      }),
      http.get('/api/collections', () => HttpResponse.json(collections)),
      http.post('/api/collections', async ({ request }) => {
        created = await request.json()
        const collection = makeCollection({ id: 'cs', name: 'Sample library', document_count: 0, indexed_count: 0, failed_count: 0 })
        collections.push(collection)
        return HttpResponse.json(collection, { status: 201 })
      }),
      http.get('/api/collections/cs/documents', () => HttpResponse.json(documents)),
      http.post('/api/collections/cs/documents', async ({ request }) => {
        const file = (await request.formData()).get('file')
        if (!(file instanceof File)) return apiError(422, 'invalid_request', 'file: missing')
        uploaded.push({ name: file.name, body: await file.text(), csrf: request.headers.get('X-PassagePort-CSRF') })
        const stored = sampleDocument(file.name, documents.length, 'processing')
        documents.push(stored)
        return HttpResponse.json({ document: stored, duplicate: false }, { status: 201 })
      }),
    )
    const { user, router } = renderApp('/')

    await screen.findByRole('heading', { name: 'Welcome to PassagePort' })
    const files = screen.getByRole('list', { name: 'Sample files' })
    expect(within(files).getAllByRole('listitem')).toHaveLength(4)
    const load = screen.getByRole('button', { name: 'Load sample documents' })
    await waitFor(() => expect(load).toBeEnabled())
    await user.click(load)

    await waitFor(() => expect(router.state.location.pathname).toBe('/c/cs'))
    expect(created).toEqual({ name: 'Sample library', description: expect.stringContaining('API specification') })
    expect(fetched.sort()).toEqual(SAMPLE_FILES.map((file) => file.name).sort())

    // Real uploads through the normal queue: one row per file, each sent as multipart.
    await waitFor(() => expect(uploaded).toHaveLength(4))
    expect(uploaded.map((item) => item.name).sort()).toEqual(SAMPLE_FILES.map((file) => file.name).sort())
    for (const item of uploaded) {
      expect(item.body).toBe(`bytes of ${item.name}`)
      expect(item.csrf).toBe('1')
    }
    const rows = await screen.findAllByTestId('upload-row')
    expect(rows).toHaveLength(4)
    await waitFor(() => expect(screen.getAllByText('Uploaded. Indexing has started.')).toHaveLength(4))

    // Suggestions appear right away but only unlock once the documents they need are indexed.
    const suggestions = await screen.findByRole('region', { name: 'Try a first query' })
    expect(within(suggestions).queryByRole('link')).not.toBeInTheDocument()
    expect(within(suggestions).getByText('deadlock prevention').closest('[aria-disabled="true"]')).not.toBeNull()
  })

  it('names the workspace uniquely and reports a sample that cannot be downloaded', async () => {
    let posted = 0
    server.use(
      http.get('/samples/:name', ({ params }) =>
        params.name === 'networking-notes.md' ? new HttpResponse('missing', { status: 404 }) : new HttpResponse('pdf'),
      ),
      http.get('/api/collections', () => HttpResponse.json([makeCollection({ id: 'c1', name: 'Sample library' })])),
      http.post('/api/collections', () => {
        posted += 1
        return apiError(500, 'internal_error', 'should not be called')
      }),
    )
    const { user } = renderApp('/')

    await screen.findByRole('heading', { level: 1, name: 'Workspaces' })
    const load = screen.getByRole('button', { name: 'Load sample documents' })
    await waitFor(() => expect(load).toBeEnabled())
    await user.click(load)

    expect(await screen.findByText('The sample file networking-notes.md could not be downloaded (404).')).toBeInTheDocument()
    // Nothing is created when the files are not all available.
    expect(posted).toBe(0)
  })

  it('links each suggestion to its screen once the documents it needs are indexed', async () => {
    const documents = SAMPLE_FILES.map((file, index) => sampleDocument(file.name, index, 'indexed'))
    server.use(
      http.get('/api/collections', () => HttpResponse.json([makeCollection({ id: 'cs', name: 'Sample library' })])),
      http.get('/api/collections/cs/documents', () => HttpResponse.json(documents)),
    )
    renderApp('/c/cs')

    const suggestions = await screen.findByRole('region', { name: 'Try a first query' })
    const hrefs = within(suggestions)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
    expect(hrefs).toEqual([
      '/c/cs/search?q=deadlock+prevention',
      '/c/cs/ask?q=What+does+ECONNRESET+mean%3F',
      '/c/cs/compare?q=rate+limiting+requests+per+minute&docs=s1%2Cs2',
      '/c/cs/lab?q=circular+wait',
    ])
  })

  it('shows no suggestions in a workspace without the samples', async () => {
    renderApp('/c/c1')
    await screen.findByRole('heading', { level: 1, name: 'Contracts' })
    expect(screen.queryByRole('region', { name: 'Try a first query' })).not.toBeInTheDocument()
  })
})
