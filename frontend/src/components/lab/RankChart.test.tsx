import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { LabIn } from '@/api/types'
import { makeDocument, makeLab } from '@/test/fixtures'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

describe('rank movement chart', () => {
  it('runs a query given in the URL and draws one line per passage across the stages', async () => {
    const seen: LabIn[] = []
    server.use(
      http.post('/api/lab/search', async ({ request }) => {
        seen.push((await request.json()) as LabIn)
        return HttpResponse.json(makeLab())
      }),
    )
    const { user } = renderApp('/c/c1/lab?q=termination+notice')

    const chart = await screen.findByTestId('rank-chart')
    expect(seen[0]).toEqual({ query: 'termination notice', collection_id: 'c1', top_k: 10, rerank: true })
    expect(screen.getByRole('textbox', { name: 'Query to inspect' })).toHaveValue('termination notice')

    const svg = within(chart).getByRole('img')
    expect(svg).toHaveAccessibleName(/Rank of 2 passages across the keyword, semantic, fused, reranked stages/)
    expect(chart.querySelectorAll('[data-series]')).toHaveLength(2)
    expect(within(chart).getByText('Reranked')).toBeInTheDocument()

    // Pointing at a line traces the passage in the stage columns too.
    await user.hover(chart.querySelector('[data-series="ch2"]') as Element)
    const keyword = screen.getByTestId('stage-keyword')
    await waitFor(() => expect(keyword.querySelector('[data-chunk="ch2"]')).toHaveAttribute('data-traced', 'true'))
  })

  it('offers the exact ranks as a table, and opens a passage from it', async () => {
    server.use(
      http.post('/api/lab/search', () => HttpResponse.json(makeLab())),
      http.get('/api/documents/:id', ({ params }) => HttpResponse.json(makeDocument({ id: String(params.id) }))),
      http.get('/api/documents/:id/outline', ({ params }) => HttpResponse.json({ document_id: params.id, locator_kind: 'section', items: [] })),
      http.get('/api/documents/:id/pages/:page', ({ params }) =>
        HttpResponse.json({ document_id: params.id, page_number: Number(params.page), page_label: 'Scope', page_count: 3, text: 'Notice must be given in writing.' }),
      ),
    )
    const { user, router } = renderApp('/c/c1/lab?q=termination+notice')

    await screen.findByTestId('rank-chart')
    await user.click(screen.getByRole('radio', { name: 'Table' }))

    const table = within(screen.getByTestId('rank-table')).getByRole('table', { name: 'Rank of each passage at each retrieval stage' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent))).toEqual([
      ['#2', '#1', '#2', '#1', 'up1'],
      ['#1', '#2', '#1', '#2', 'down1'],
    ])

    await user.click(within(rows[0]).getByRole('button', { name: 'Master agreement · Scope' }))
    expect(new URLSearchParams(router.state.location.search).get('hit')).toBe('ch2')
  })
})
