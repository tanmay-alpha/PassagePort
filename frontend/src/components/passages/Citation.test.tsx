import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { makeAsk, makeDocument, makeEvidence } from '@/test/fixtures'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const evidence = [
  makeEvidence(1, { document_title: 'os-notes', locator_kind: 'page', page_number: 2, page_label: 'Page 2', text: 'Lock ordering prevents circular wait.', matched_terms: ['circular'] }),
  makeEvidence(2, { document_title: 'os-notes', locator_kind: 'page', page_number: 3, page_label: 'Page 3', text: 'Detection finds cycles after the fact.' }),
  makeEvidence(3, { text: 'Retrieved but not cited.', page_label: 'Fees' }),
]

const viewerHandlers = [
  http.get('/api/documents/:id', ({ params }) => HttpResponse.json(makeDocument({ id: String(params.id) }))),
  http.get('/api/documents/:id/outline', ({ params }) => HttpResponse.json({ document_id: params.id, locator_kind: 'section', items: [] })),
  http.get('/api/documents/:id/pages/:page', ({ params }) =>
    HttpResponse.json({ document_id: params.id, page_number: Number(params.page), page_label: 'Page', page_count: 3, text: 'Lock ordering prevents circular wait.' }),
  ),
]

function answer() {
  return makeAsk({
    mode: 'generated',
    llm_model: 'test-model',
    segments: [
      { text: 'Ordering locks prevents deadlock.', citations: [1], supported: true },
      { text: 'Cycles can also be detected later.', citations: [2, 1], supported: true },
      { text: 'Most systems ignore the problem.', citations: [], supported: false },
    ],
    evidence,
  })
}

describe('citations in answers', () => {
  it('lists the cited sources above the answer in citation order and opens one in the preview', async () => {
    server.use(http.post('/api/ask', () => HttpResponse.json(answer())), ...viewerHandlers)
    const { user, router } = renderApp('/c/c1/ask?q=deadlock')

    const sources = await screen.findByRole('region', { name: 'Sources' })
    const cards = within(sources).getAllByRole('button')
    // Only passages the answer cites; the uncited one stays in the evidence list below.
    expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual(['Source 1: os-notes, Page 2', 'Source 2: os-notes, Page 3'])
    expect(cards[0]).toHaveAccessibleDescription('Lock ordering prevents circular wait.')
    // The sources row comes before the answer in reading order.
    const region = screen.getByRole('region', { name: 'Answer' })
    expect(sources.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Pointing at a source tints the sentences that cite it.
    await user.hover(cards[1])
    const linked = within(region).getByTestId('answer-text').querySelectorAll('[data-linked="true"]')
    expect(Array.from(linked).map((segment) => segment.textContent)).toEqual([expect.stringContaining('Cycles can also be detected later.')])

    await user.click(cards[1])
    expect(new URLSearchParams(router.state.location.search).get('hit')).toBe('ev2')
    await waitFor(() => expect(cards[1]).toHaveAttribute('aria-current', 'true'))
  })

  it('previews the cited excerpt with its page when a chip gets keyboard focus, and opens it from there', async () => {
    server.use(http.post('/api/ask', () => HttpResponse.json(answer())), ...viewerHandlers)
    const { user, router } = renderApp('/c/c1/ask?q=deadlock')

    const text = await screen.findByTestId('answer-text')
    const chip = within(text).getAllByRole('button', { name: 'Citation 1: show the cited passage' })[0]
    while (document.activeElement !== chip) await user.tab()

    const popover = await screen.findByTestId('citation-popover')
    expect(popover).toHaveTextContent('os-notes')
    expect(popover).toHaveTextContent('p. 2')
    expect(popover).toHaveTextContent('Lock ordering prevents circular wait.')
    expect(within(popover).getByText('circular').tagName).toBe('MARK')
    // Focus stays on the chip; the excerpt is its description.
    expect(chip).toHaveFocus()
    expect(chip).toHaveAccessibleDescription(expect.stringContaining('Lock ordering prevents circular wait.'))

    await user.click(within(popover).getByRole('button', { name: 'Open in document' }))
    expect(new URLSearchParams(router.state.location.search).get('hit')).toBe('ev1')
    await waitFor(() => expect(screen.queryByTestId('citation-popover')).not.toBeInTheDocument())
    expect(await screen.findByRole('region', { name: 'Document preview' })).toBeInTheDocument()
  })

  it('closes the preview popover with Escape without leaving the chip', async () => {
    server.use(http.post('/api/ask', () => HttpResponse.json(answer())))
    const { user } = renderApp('/c/c1/ask?q=deadlock')

    const text = await screen.findByTestId('answer-text')
    const chip = within(text).getAllByRole('button', { name: /^Citation 2/ })[0]
    while (document.activeElement !== chip) await user.tab()
    await screen.findByTestId('citation-popover')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('citation-popover')).not.toBeInTheDocument())
    expect(chip).toHaveFocus()
  })

  it('marks unsupported sentences and counts them', async () => {
    server.use(http.post('/api/ask', () => HttpResponse.json(answer())))
    renderApp('/c/c1/ask?q=deadlock')

    const region = await screen.findByRole('region', { name: 'Answer' })
    expect(within(region).getByText('1 unsupported')).toBeInTheDocument()
    const unsupported = within(region).getByTestId('answer-text').querySelector('[data-supported="false"]')
    expect(unsupported).toHaveTextContent('Most systems ignore the problem.No citation')
  })

  it('makes the insufficient state explicit and offers the same question in Search', async () => {
    server.use(
      http.post('/api/ask', () =>
        HttpResponse.json(makeAsk({ mode: 'insufficient', segments: [], notice: 'Nothing relevant enough was found.', evidence: [evidence[2]] })),
      ),
    )
    renderApp('/c/c1/ask?q=Who+signed+it%3F')

    const region = await screen.findByRole('region', { name: 'Answer' })
    expect(within(region).getByText('PassagePort did not write an answer.')).toBeInTheDocument()
    expect(within(region).getByRole('link', { name: 'Browse the matching passages in Search' })).toHaveAttribute(
      'href',
      '/c/c1/search?q=What+is+the+notice+period%3F',
    )
    expect(screen.queryByRole('region', { name: 'Sources' })).not.toBeInTheDocument()
  })
})
