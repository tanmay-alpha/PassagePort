import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { INDEXING_POLL_MS } from '@/api/queries'
import type { DocumentOut } from '@/api/types'
import { makeCollection, makeDocument } from '@/test/fixtures'
import { renderApp } from '@/test/render'
import { apiError, server } from '@/test/server'

function workspace(id: string) {
  return http.get('/api/collections', () => HttpResponse.json([makeCollection({ id })]))
}

function pdf(name: string, size = 2048): File {
  return new File([new Uint8Array(size)], name, { type: 'application/pdf' })
}

describe('uploading', () => {
  it('reports a stored file, a duplicate and a server rejection per file', async () => {
    const documents: DocumentOut[] = []
    const received: string[] = []
    server.use(
      workspace('up1'),
      http.get('/api/collections/up1/documents', () => HttpResponse.json(documents)),
      http.post('/api/collections/up1/documents', async ({ request }) => {
        expect(request.headers.get('X-PassagePort-CSRF')).toBe('1')
        const file = (await request.formData()).get('file')
        if (!(file instanceof File)) return apiError(422, 'invalid_request', 'file: missing')
        received.push(file.name)
        if (file.name === 'handbook.pdf') {
          const stored = makeDocument({ id: 'new1', collection_id: 'up1', title: 'handbook', filename: file.name, kind: 'pdf', locator_kind: 'page', status: 'uploaded', page_count: 0, chunk_count: 0, indexed_at: null })
          documents.push(stored)
          return HttpResponse.json({ document: stored, duplicate: false }, { status: 201 })
        }
        if (file.name === 'copy.pdf') {
          return HttpResponse.json({ document: makeDocument({ id: 'old1', collection_id: 'up1', title: 'Original handbook' }), duplicate: true })
        }
        return apiError(415, 'unsupported_file', 'This file is not a valid PDF.')
      }),
    )
    const { user } = renderApp('/c/up1')

    const input = await screen.findByTestId('file-input')
    await user.upload(input, [pdf('handbook.pdf'), pdf('copy.pdf'), pdf('broken.pdf')])

    const rows = await screen.findAllByTestId('upload-row')
    expect(rows).toHaveLength(3)
    expect(await within(rows[0]).findByText('Uploaded. Indexing has started.')).toBeInTheDocument()
    expect(await within(rows[1]).findByText('Already in this workspace as “Original handbook”. Nothing was stored twice.')).toBeInTheDocument()
    expect(await within(rows[2]).findByText('This file is not a valid PDF.')).toBeInTheDocument()
    expect(received.sort()).toEqual(['broken.pdf', 'copy.pdf', 'handbook.pdf'])

    // The stored document shows up in the list without a manual refresh.
    expect(await screen.findByRole('link', { name: 'handbook' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear finished' }))
    expect(screen.queryByTestId('upload-row')).not.toBeInTheDocument()
  })

  it('stops unsupported and oversized files before sending anything', async () => {
    let uploads = 0
    server.use(
      workspace('up2'),
      http.get('/api/collections/up2/documents', () => HttpResponse.json([])),
      http.post('/api/collections/up2/documents', () => {
        uploads += 1
        return apiError(500, 'internal_error', 'should not be called')
      }),
    )
    renderApp('/c/up2')
    // `accept` would hide the wrong type in a real picker; drag-and-drop does not filter.
    const user = userEvent.setup({ applyAccept: false })

    const input = await screen.findByTestId('file-input')
    await user.upload(input, [new File(['MZ'], 'setup.exe'), pdf('huge.pdf', 1024 * 1024 + 1), new File([], 'empty.txt')])

    const rows = await screen.findAllByTestId('upload-row')
    expect(within(rows[0]).getByText(/Unsupported file type\. Allowed: \.pdf, \.txt, \.md, \.docx\./)).toBeInTheDocument()
    expect(within(rows[1]).getByText(/is over the 1\.0 MB limit per file/)).toBeInTheDocument()
    expect(within(rows[2]).getByText(/The file is empty/)).toBeInTheDocument()
    expect(uploads).toBe(0)
  })

  it('shows an indeterminate bar while a transfer is in flight', async () => {
    server.use(
      workspace('up3'),
      http.get('/api/collections/up3/documents', () => HttpResponse.json([])),
      http.post('/api/collections/up3/documents', async () => {
        await delay(300)
        return apiError(413, 'payload_too_large', 'The file is larger than the server accepts.')
      }),
    )
    const { user } = renderApp('/c/up3')

    await user.upload(await screen.findByTestId('file-input'), pdf('slow.pdf'))

    const bar = await screen.findByRole('progressbar', { name: 'Uploading slow.pdf' })
    const value = bar.getAttribute('aria-valuenow')
    // Either real byte progress (0..100) or no value at all; never an invented number.
    expect(value === null || (Number(value) >= 0 && Number(value) <= 100)).toBe(true)
    expect(await screen.findByText('The file is larger than the server accepts.')).toBeInTheDocument()
  })
})

describe('documents', () => {
  it('distinguishes every status and offers a retry with the server error', async () => {
    let reindexed: string | null = null
    const documents = [
      makeDocument({ id: 'q', title: 'Queued doc', status: 'uploaded', page_count: 0 }),
      makeDocument({ id: 'p', title: 'Processing doc', status: 'processing', page_count: 0 }),
      makeDocument({ id: 'i', title: 'Indexed doc' }),
      makeDocument({ id: 'f', title: 'Failed doc', status: 'failed', error: 'The PDF is encrypted.', page_count: 0 }),
      makeDocument({ id: 's', title: 'Stale doc', stale: true }),
    ].map((document) => ({ ...document, collection_id: 'st1' }))
    server.use(
      workspace('st1'),
      http.get('/api/collections/st1/documents', () => HttpResponse.json(documents)),
      http.post('/api/documents/:id/reindex', ({ params }) => {
        reindexed = String(params.id)
        documents[3] = { ...documents[3], status: 'uploaded', error: null }
        return HttpResponse.json(documents[3], { status: 202 })
      }),
    )
    const { user } = renderApp('/c/st1')

    const expectBadge = async (title: string, badge: string) => {
      const row = (await screen.findByRole('link', { name: title })).closest('tr')
      expect(row).not.toBeNull()
      expect(within(row as HTMLElement).getByText(badge)).toBeInTheDocument()
      return row as HTMLElement
    }
    await expectBadge('Queued doc', 'Queued')
    await expectBadge('Processing doc', 'Indexing')
    await expectBadge('Indexed doc', 'Indexed')
    await expectBadge('Stale doc', 'Needs re-index')
    const failed = await expectBadge('Failed doc', 'Failed')
    expect(within(failed).getByText('The PDF is encrypted.')).toBeInTheDocument()

    await user.click(within(failed).getByRole('button', { name: 'Retry indexing of Failed doc' }))
    await waitFor(() => expect(reindexed).toBe('f'))
    // The 202 response replaces the row immediately: it is queued again.
    await waitFor(() => expect(within(failed).getByText('Queued')).toBeInTheDocument())
  })

  it('filters by text and status', async () => {
    server.use(
      workspace('fl1'),
      http.get('/api/collections/fl1/documents', () =>
        HttpResponse.json([
          makeDocument({ id: 'a', title: 'Alpha report' }),
          makeDocument({ id: 'b', title: 'Beta memo', status: 'failed', error: 'Unreadable file.' }),
        ]),
      ),
    )
    const { user } = renderApp('/c/fl1')

    await user.type(await screen.findByLabelText('Filter documents by title or file name'), 'beta')
    expect(screen.queryByRole('link', { name: 'Alpha report' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Beta memo' })).toBeInTheDocument()
    expect(screen.getByText('1 of 2 documents')).toBeInTheDocument()

    await user.clear(screen.getByLabelText('Filter documents by title or file name'))
    await user.type(screen.getByLabelText('Filter documents by title or file name'), 'zzz')
    expect(screen.getByText('No documents match these filters')).toBeInTheDocument()
  })

  it('polls while a document is being indexed and stops once it is done', async () => {
    let calls = 0
    server.use(
      workspace('po1'),
      http.get('/api/collections/po1/documents', () => {
        calls += 1
        return HttpResponse.json([makeDocument({ id: 'x', title: 'Slow doc', status: calls < 2 ? 'processing' : 'indexed' })])
      }),
    )
    renderApp('/c/po1')

    const row = (await screen.findByRole('link', { name: 'Slow doc' })).closest('tr') as HTMLElement
    expect(within(row).getByText('Indexing')).toBeInTheDocument()
    await waitFor(() => expect(within(row).getByText('Indexed')).toBeInTheDocument(), { timeout: INDEXING_POLL_MS * 3 })

    const settled = calls
    await new Promise((resolve) => setTimeout(resolve, INDEXING_POLL_MS * 2 + 200))
    expect(calls).toBe(settled)
  })

  it('confirms before deleting and removes the row', async () => {
    let documents = [makeDocument({ id: 'del', collection_id: 'de1', title: 'Old policy' })]
    server.use(
      workspace('de1'),
      http.get('/api/collections/de1/documents', () => HttpResponse.json(documents)),
      http.delete('/api/documents/del', () => {
        documents = []
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { user } = renderApp('/c/de1')

    await user.click(await screen.findByRole('button', { name: 'Actions for Old policy' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete “Old policy”?' })
    await user.click(within(dialog).getByRole('button', { name: 'Delete document' }))

    await waitFor(() => expect(screen.queryByRole('link', { name: 'Old policy' })).not.toBeInTheDocument())
    expect(await screen.findByText('No documents yet')).toBeInTheDocument()
  })
})
