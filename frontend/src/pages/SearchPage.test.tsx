import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { SearchIn } from '@/api/types'
import { makeDocument, makeHit, makeSearch, makeSystem, rerankerModel } from '@/test/fixtures'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const PASSAGE = 'Either party may terminate with 30 days notice.'
// The emoji is one code point but two UTF-16 units: offsets from the server count code points.
const PAGE_TEXT = `Clause 9 😀 overview.\n${PASSAGE} Other terms follow.`
const CHAR_START = Array.from(PAGE_TEXT.slice(0, PAGE_TEXT.indexOf(PASSAGE))).length
const CHAR_END = CHAR_START + Array.from(PASSAGE).length

function searchReturns(response = makeSearch(), seen: SearchIn[] = []) {
  return http.post('/api/search', async ({ request }) => {
    seen.push((await request.json()) as SearchIn)
    return HttpResponse.json(response)
  })
}

const viewerHandlers = [
  http.get('/api/documents/:id', ({ params }) => HttpResponse.json(makeDocument({ id: String(params.id) }))),
  http.get('/api/documents/:id/outline', ({ params }) =>
    HttpResponse.json({
      document_id: params.id,
      locator_kind: 'section',
      items: [
        { page_number: 1, page_label: 'Scope' },
        { page_number: 2, page_label: 'Termination' },
        { page_number: 3, page_label: 'Fees' },
      ],
    }),
  ),
  http.get('/api/documents/:id/pages/:page', ({ params }) =>
    HttpResponse.json({
      document_id: params.id,
      page_number: Number(params.page),
      page_label: Number(params.page) === 2 ? 'Termination' : `Section ${String(params.page)}`,
      page_count: 3,
      text: Number(params.page) === 2 ? PAGE_TEXT : 'Notice must be given in writing.',
    }),
  ),
]

describe('search', () => {
  it('sends the query and renders hits with matched terms and honest scores', async () => {
    const seen: SearchIn[] = []
    server.use(searchReturns(makeSearch(), seen))
    const { user, router } = renderApp('/c/c1/search')

    await user.type(await screen.findByRole('searchbox', { name: 'Search Contracts' }), 'termination notice{Enter}')

    const list = await screen.findByRole('list', { name: 'Search results' })
    const items = within(list).getAllByRole('listitem').filter((item) => item.parentElement === list)
    expect(items).toHaveLength(2)
    expect(seen[0]).toMatchObject({ query: 'termination notice', collection_id: 'c1', mode: 'hybrid', rerank: null, document_ids: null })
    expect(router.state.location.search).toBe('?q=termination+notice')

    const first = within(items[0])
    expect(first.getByText('Master agreement')).toBeInTheDocument()
    expect(first.getByText('Termination')).toBeInTheDocument()
    expect(Array.from(items[0].querySelectorAll('mark')).map((mark) => mark.textContent)).toEqual(['terminate', 'notice'])
    expect(first.getByRole('button', { name: 'Keyword #1 · BM25 7.42' })).toBeInTheDocument()
    expect(first.getByRole('button', { name: 'Semantic #2 · similarity 0.713' })).toBeInTheDocument()
    expect(first.getByRole('button', { name: 'Fused 0.0325' })).toBeInTheDocument()
    expect(first.getByRole('button', { name: 'Rerank 4.20' })).toBeInTheDocument()
    expect(within(items[1]).getByRole('button', { name: 'No keyword match' })).toBeInTheDocument()
    expect(screen.queryByText(/%/)).not.toBeInTheDocument()

    expect(screen.getByText(/2 passages for “termination notice” · Hybrid, reranked with Xenova\/ms-marco-MiniLM-L-6-v2 · 26 ms/)).toBeInTheDocument()
  })

  it('explains a score on focus', async () => {
    server.use(searchReturns())
    const { user } = renderApp('/c/c1/search?q=termination+notice')

    const metric = await screen.findByRole('button', { name: 'Rerank 4.20' })
    metric.focus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/cross-encoder.*not a percentage/i)
    await user.keyboard('{Escape}')
  })

  it('flags low-confidence results with the server notice', async () => {
    server.use(searchReturns(makeSearch({ low_confidence: true, notice: 'Nothing cleared the relevance threshold; these are the closest passages.' })))
    renderApp('/c/c1/search?q=termination+notice')

    expect(await screen.findByText('Low-confidence results')).toBeInTheDocument()
    expect(screen.getByText('Nothing cleared the relevance threshold; these are the closest passages.')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Search results' })).toBeInTheDocument()
  })

  it('shows an empty state with the server notice when nothing matches', async () => {
    server.use(searchReturns(makeSearch({ results: [], low_confidence: true, notice: 'No indexed passage matches this query.' })))
    renderApp('/c/c1/search?q=zebra')

    expect(await screen.findByRole('heading', { name: 'No matching passages' })).toBeInTheDocument()
    expect(screen.getByText('No indexed passage matches this query.')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Search results' })).not.toBeInTheDocument()
  })

  it('reads mode, rerank and document filter from the URL and sends them', async () => {
    const seen: SearchIn[] = []
    server.use(searchReturns(makeSearch({ settings: { ...makeSearch().settings, mode: 'semantic', reranked: false } }), seen))
    const { user } = renderApp('/c/c1/search?q=notice&mode=semantic&rerank=0&docs=d1')

    await screen.findByRole('list', { name: 'Search results' })
    expect(seen[0]).toMatchObject({ query: 'notice', mode: 'semantic', rerank: false, document_ids: ['d1'] })
    expect(screen.getByRole('searchbox')).toHaveValue('notice')
    expect(screen.getByRole('radio', { name: 'Semantic' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Rerank' })).not.toBeChecked()

    await user.click(screen.getByRole('radio', { name: 'Keyword' }))
    await waitFor(() => expect(seen.at(-1)).toMatchObject({ mode: 'keyword' }))
  })

  it('disables reranking with an explanation when the server has no reranker', async () => {
    server.use(http.get('/api/system', () => HttpResponse.json(makeSystem({ reranker: { ...rerankerModel, backend: 'none', enabled: false } }))))
    renderApp('/c/c1/search')

    const toggle = await screen.findByRole('switch', { name: 'Rerank' })
    await waitFor(() => expect(toggle).toBeDisabled())
    expect(screen.getByText('Unavailable: this server runs without a reranker model.')).toBeInTheDocument()
  })
})

describe('opening a hit', () => {
  it('shows the Text view with exactly char_start..char_end highlighted', async () => {
    server.use(
      searchReturns(makeSearch({ results: [makeHit({ text: PASSAGE, char_start: CHAR_START, char_end: CHAR_END })] })),
      ...viewerHandlers,
    )
    const { user, router } = renderApp('/c/c1/search?q=termination+notice')

    const list = await screen.findByRole('list', { name: 'Search results' })
    await user.click(within(list).getByRole('button', { name: /Either party may terminate/ }))

    const preview = await screen.findByRole('region', { name: 'Document preview' })
    const cited = await within(preview).findByTestId('cited-passage')
    expect(cited.textContent).toBe(PASSAGE)
    expect(within(preview).getByTestId('page-text').textContent).toBe(PAGE_TEXT)
    expect(within(preview).getByRole('heading', { name: 'Master agreement' })).toBeInTheDocument()
    expect(new URLSearchParams(router.state.location.search).get('hit')).toBe('ch1')

    // The back button closes the preview again.
    await router.navigate(-1)
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Document preview' })).not.toBeInTheDocument())
  })

  it('says so instead of highlighting when the passage is no longer on the page', async () => {
    server.use(searchReturns(makeSearch({ results: [makeHit({ text: 'A sentence that was edited away.', char_start: 400, char_end: 432 })] })), ...viewerHandlers)
    const { user } = renderApp('/c/c1/search?q=termination+notice')

    await user.click(await screen.findByRole('button', { name: /A sentence that was edited away/ }))

    const preview = await screen.findByRole('region', { name: 'Document preview' })
    expect(await within(preview).findByText('The cited passage could not be found on this page.')).toBeInTheDocument()
    expect(within(preview).queryByTestId('cited-passage')).not.toBeInTheDocument()
  })

  it('moves between hits with the arrow keys, opens with Enter and closes with Escape', async () => {
    server.use(searchReturns(), ...viewerHandlers)
    const { user, router } = renderApp('/c/c1/search?q=termination+notice')
    const hitParam = () => new URLSearchParams(router.state.location.search).get('hit')

    const list = await screen.findByRole('list', { name: 'Search results' })
    const [first, second] = within(list).getAllByRole('button', { name: /Open in document viewer/ })

    screen.getByRole('searchbox').focus()
    await user.keyboard('{ArrowDown}')
    expect(first).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(second).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(first).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(await screen.findByRole('region', { name: 'Document preview' })).toBeInTheDocument()
    expect(hitParam()).toBe('ch1')
    expect(first).toHaveAttribute('aria-current', 'true')

    // With the preview open it follows the focused hit.
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(hitParam()).toBe('ch2'))

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Document preview' })).not.toBeInTheDocument())
    expect(hitParam()).toBeNull()
  })
})
