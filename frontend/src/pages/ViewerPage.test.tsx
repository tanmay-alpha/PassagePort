import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { makeDocument, makeHit } from '@/test/fixtures'
import { renderApp } from '@/test/render'
import { apiError, server } from '@/test/server'

function serveCitation(text: string, passage: string, start: number, end: number) {
  server.use(
    http.get('/api/documents/d1', () => HttpResponse.json(makeDocument({ page_count: 1 }))),
    http.get('/api/documents/d1/outline', () => HttpResponse.json({ document_id: 'd1', locator_kind: 'section', items: [{ page_number: 1, page_label: 'Terms' }] })),
    http.get('/api/documents/d1/pages/1', () => HttpResponse.json({ document_id: 'd1', page_number: 1, page_label: 'Terms', page_count: 1, text })),
    http.get('/api/chunks/ch1', () => HttpResponse.json(makeHit({ page_number: 1, page_label: 'Terms', text: passage, char_start: start, char_end: end }))),
  )
}

describe('viewer extracted text', () => {
  it.each([
    { text: 'same / same / end', passage: 'same', start: 7, end: 11, before: 'same / ', after: ' / end' },
    { text: '😀 same / 🧭 same / end', passage: 'same', start: 11, end: 15, before: '😀 same / 🧭 ', after: ' / end' },
    { text: '🧭 first / 🧭 first / end', passage: '🧭 first', start: 10, end: 17, before: '🧭 first / ', after: ' / end' },
  ])('highlights exactly code points $start..$end in $text', async ({ text, passage, start, end, before, after }) => {
    serveCitation(text, passage, start, end)
    renderApp('/d/d1?chunk=ch1')

    const mark = await screen.findByTestId('cited-passage')
    expect(mark.tagName).toBe('MARK')
    expect(mark.textContent).toBe(passage)
    expect(mark.previousSibling?.textContent).toBe(before)
    expect(mark.nextSibling?.textContent).toBe(after)
    expect(screen.getByTestId('page-text').textContent).toBe(text)
    expect(screen.getAllByTestId('cited-passage')).toHaveLength(1)
  })

  it('shows the exact Unicode citation in a PDF’s Text tab', async () => {
    serveCitation('😀 same / 🧭 same / end', 'same', 11, 15)
    server.use(
      http.get('/api/documents/d1', () => HttpResponse.json(makeDocument({ kind: 'pdf', locator_kind: 'page', filename: 'agreement.pdf', page_count: 1 }))),
      http.get('/api/documents/d1/file', () => new HttpResponse(null, { status: 404 })),
    )
    const { user } = renderApp('/d/d1?chunk=ch1')
    await user.click(await screen.findByRole('tab', { name: 'Text' }))

    expect(screen.getByRole('tab', { name: 'Text' })).toHaveAttribute('aria-selected', 'true')
    const mark = await screen.findByTestId('cited-passage')
    expect(mark.textContent).toBe('same')
    expect(mark.previousSibling?.textContent).toBe('😀 same / 🧭 ')
    expect(mark.nextSibling?.textContent).toBe(' / end')
    expect(screen.getByTestId('page-text').textContent).toBe('😀 same / 🧭 same / end')
  })
  it('warns without highlighting when a citation cannot be found', async () => {
    serveCitation('The replacement document.', 'The deleted passage.', 0, 20)

    renderApp('/d/d1?chunk=ch1')

    expect(await screen.findByText('The cited passage could not be found on this page.')).toBeInTheDocument()
    expect(screen.queryByTestId('cited-passage')).not.toBeInTheDocument()
    expect(screen.getByTestId('page-text')).toHaveTextContent('The replacement document.')
  })

  it('keeps the document readable when the cited chunk was deleted', async () => {
    serveCitation('Current document text.', 'Current', 0, 7)
    server.use(http.get('/api/chunks/ch1', () => apiError(404, 'not_found', 'Passage not found.')))
    renderApp('/d/d1?chunk=ch1')

    expect(await screen.findByText('The cited passage no longer exists.')).toBeInTheDocument()
    expect(await screen.findByTestId('page-text')).toHaveTextContent('Current document text.')
    expect(screen.queryByTestId('cited-passage')).not.toBeInTheDocument()
  })
})
