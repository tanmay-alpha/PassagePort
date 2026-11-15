import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'

import { makeDocument, makeHit, makeSearch } from '@/test/fixtures'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const results = makeSearch().results
const third = makeHit({ chunk_id: 'ch3', rank: 3, page_number: 3, page_label: 'Fees', text: 'Fees are payable within 14 days.', matched_terms: [] })
const search = makeSearch({ results: [...results, third] })

const viewerHandlers = [
  http.get('/api/documents/:id', ({ params }) => HttpResponse.json(makeDocument({ id: String(params.id) }))),
  http.get('/api/documents/:id/outline', ({ params }) => HttpResponse.json({ document_id: params.id, locator_kind: 'section', items: [] })),
  http.get('/api/documents/:id/pages/:page', ({ params }) =>
    HttpResponse.json({
      document_id: params.id,
      page_number: Number(params.page),
      page_label: 'Section',
      page_count: 3,
      text: 'Either party may terminate with 30 days notice. Fees are payable within 14 days.',
    }),
  ),
]

describe('search results', () => {
  it('switches between ranked order and grouping by document, keeping the choice in the URL', async () => {
    server.use(http.post('/api/search', () => HttpResponse.json(search)))
    const { user, router } = renderApp('/c/c1/search?q=notice')

    const ranked = await screen.findByRole('list', { name: 'Search results' })
    expect(within(ranked).getAllByRole('button', { name: /Open in document viewer/ }).map((button) => button.getAttribute('data-passage'))).toEqual([
      'ch1',
      'ch2',
      'ch3',
    ])

    const arrange = screen.getByRole('radiogroup', { name: 'Arrange results' })
    await user.click(within(arrange).getByRole('radio', { name: 'By document' }))

    expect(new URLSearchParams(router.state.location.search).get('group')).toBe('document')
    const grouped = await screen.findByRole('group', { name: 'Search results grouped by document' })
    const sections = within(grouped).getAllByRole('region')
    expect(sections.map((section) => within(section).getByRole('heading').textContent)).toEqual([
      'Master agreement2 results',
      'Service addendum1 result',
    ])
    expect(within(sections[0]).getAllByRole('button', { name: /Open in document viewer/ }).map((button) => button.getAttribute('data-passage'))).toEqual([
      'ch1',
      'ch3',
    ])

    // Arrow keys still walk every result, across groups.
    const first = within(sections[0]).getAllByRole('button', { name: /Open in document viewer/ })[0]
    first.focus()
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(within(sections[1]).getByRole('button', { name: /Open in document viewer/ })).toHaveFocus()
  })

  it('copies a plain-text citation', async () => {
    server.use(http.post('/api/search', () => HttpResponse.json(search)))
    const { user } = renderApp('/c/c1/search?q=notice')
    // user-event installs a clipboard stub; only plain text may ever be written to it.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    const write = vi.spyOn(navigator.clipboard, 'write')

    const copy = await screen.findByRole('button', { name: 'Copy citation for Master agreement, Fees' })
    await user.click(copy)

    expect(writeText).toHaveBeenCalledWith('Master agreement, § Fees — “Fees are payable within 14 days.”')
    expect(write).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: 'Citation copied' })).toBeInTheDocument()
  })

  it('maps the other results of the query onto the previewed document and jumps between them', async () => {
    server.use(http.post('/api/search', () => HttpResponse.json(search)), ...viewerHandlers)
    const { user, router } = renderApp('/c/c1/search?q=notice&hit=ch1')

    const preview = await screen.findByRole('region', { name: 'Document preview' })
    const strip = await within(preview).findByRole('list', { name: 'Results in this document' })
    // Only this document's results (1 and 3); result 2 is in another document.
    const ticks = within(strip).getAllByRole('button')
    expect(ticks.map((tick) => tick.getAttribute('aria-label'))).toEqual(['Result 1, Termination, shown', 'Result 3, Fees'])
    expect(ticks[0]).toHaveAttribute('aria-current', 'true')

    await user.click(ticks[1])
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('hit')).toBe('ch3'))
    const updated = await within(await screen.findByRole('region', { name: 'Document preview' })).findByRole('list', { name: 'Results in this document' })
    await waitFor(() => expect(within(updated).getByRole('button', { name: 'Result 3, Fees, shown' })).toHaveAttribute('aria-current', 'true'))
  })
})
