import { screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { LabIn } from '@/api/types'
import { makeEvalReport, makeLab } from '@/test/fixtures'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

describe('search lab', () => {
  it('runs every stage and makes rank movement visible across columns', async () => {
    const seen: LabIn[] = []
    server.use(
      http.post('/api/lab/search', async ({ request }) => {
        seen.push((await request.json()) as LabIn)
        return HttpResponse.json(makeLab())
      }),
    )
    const { user } = renderApp('/c/c1/lab')

    await user.type(await screen.findByRole('textbox', { name: 'Query to inspect' }), 'termination notice')
    await user.click(screen.getByRole('button', { name: 'Run' }))

    const keyword = await screen.findByRole('region', { name: 'Keyword (BM25)' })
    expect(seen[0]).toEqual({
      query: 'termination notice',
      collection_id: 'c1',
      document_ids: null,
      top_k: 10,
      candidates: null,
      rrf_k: null,
      lexical_weight: null,
      vector_weight: null,
      rerank: true,
    })
    for (const stage of ['Semantic', 'Fused', 'Reranked']) {
      expect(within(screen.getByRole('region', { name: stage })).getAllByRole('listitem')).toHaveLength(2)
    }
    const firstKeyword = within(keyword).getByRole('button', { name: /Either party may terminate/ })
    expect(within(firstKeyword).getByText('BM25 7.42')).toBeInTheDocument()

    // Tokenized query terms and measured latency.
    expect(within(screen.getByRole('list', { name: 'Tokenized query terms' })).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['termination', 'notice'])
    const latency = screen.getByRole('region', { name: /^Latency/ })
    expect(latency).toHaveTextContent('25 ms total')
    expect(latency).toHaveTextContent('Embed query3.5 ms')
    expect(latency).toHaveTextContent('Rerank18 ms')

    // Hovering a passage marks it in all four columns and reports its rank in each.
    const second = within(keyword).getByRole('button', { name: /Notice must be given in writing/ })
    await user.hover(second)
    const traced = document.querySelectorAll('[data-traced="true"]')
    expect(traced).toHaveLength(4)
    expect(Array.from(traced).every((element) => element.getAttribute('data-chunk') === 'ch2')).toBe(true)
    const stages = screen.getByRole('region', { name: 'Rankings by stage' })
    expect(stages).toHaveTextContent('Keyword #2')
    expect(stages).toHaveTextContent('Semantic #1')
    expect(stages).toHaveTextContent('Fused #2')
    expect(stages).toHaveTextContent('Reranked #1')

    const config = screen.getByRole('region', { name: 'Index and model configuration' })
    expect(config).toHaveTextContent('exact cosine (brute force)')
    expect(config).toHaveTextContent('BAAI/bge-small-en-v1.5')
    expect(config).toHaveTextContent('512 terms')
  })

  it('says when reranking did not run instead of showing an empty ranking', async () => {
    server.use(http.post('/api/lab/search', () => HttpResponse.json(makeLab({ reranked: null }))))
    const { user } = renderApp('/c/c1/lab')

    await user.type(await screen.findByRole('textbox', { name: 'Query to inspect' }), 'termination notice{Enter}')

    const reranked = await screen.findByRole('region', { name: 'Reranked' })
    expect(within(reranked).getByText(/Reranking was not run for this query/)).toBeInTheDocument()
    expect(screen.getByRole('region', { name: /^Latency/ })).toHaveTextContent('Reranknot run')
  })

  it('validates settings against the API ranges before sending', async () => {
    let requests = 0
    server.use(
      http.post('/api/lab/search', () => {
        requests += 1
        return HttpResponse.json(makeLab())
      }),
    )
    const { user } = renderApp('/c/c1/lab')

    await user.type(await screen.findByRole('textbox', { name: 'Query to inspect' }), 'notice')
    await user.type(screen.getByLabelText('Candidates per retriever'), '999')
    await user.click(screen.getByRole('button', { name: 'Run' }))

    expect(await screen.findByText('Enter a whole number from 1 to 200.')).toBeInTheDocument()
    expect(requests).toBe(0)
  })

  it('shows a clear empty state when the server has no evaluation report', async () => {
    renderApp('/c/c1/lab')

    const evaluation = await screen.findByRole('region', { name: 'Evaluation' })
    expect(await within(evaluation).findByRole('heading', { name: 'No evaluation report on this server' })).toBeInTheDocument()
    expect(within(evaluation).queryByRole('table')).not.toBeInTheDocument()
  })

  it('renders the committed evaluation report with its provenance', async () => {
    server.use(http.get('/api/lab/evaluation', () => HttpResponse.json(makeEvalReport())))
    renderApp('/c/c1/lab')

    const evaluation = await screen.findByRole('region', { name: 'Evaluation' })
    const table = await within(evaluation).findByRole('table', { name: 'Retrieval metrics per pipeline for handbook-qa' })
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Pipeline', 'Recall@1', 'Recall@5', 'MRR', 'nDCG@10', 'p50', 'p95'])
    const row = within(table).getByRole('row', { name: /hybrid\+rerank/ })
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['0.740', '0.940', '0.827', '0.860', '41 ms', '77 ms'])
    expect(evaluation).toHaveTextContent('abc1234')
    expect(evaluation).toHaveTextContent('uv run python -m passageport.evaluation.run')
  })
})
