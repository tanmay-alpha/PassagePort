import { screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { CompareIn, CompareOut } from '@/api/types'
import { makeCompare, makeDocument, makeSystem } from '@/test/fixtures'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const threeDocuments = http.get('/api/collections/c1/documents', () =>
  HttpResponse.json([
    makeDocument({ id: 'd1', title: 'Master agreement' }),
    makeDocument({ id: 'd2', title: 'Service addendum' }),
    makeDocument({ id: 'd3', title: 'Pricing sheet' }),
    makeDocument({ id: 'd4', title: 'Draft (still indexing)', status: 'processing' }),
  ]),
)

function compareReturns(response: CompareOut, seen: CompareIn[] = []) {
  return http.post('/api/compare', async ({ request }) => {
    seen.push((await request.json()) as CompareIn)
    return HttpResponse.json(response)
  })
}

describe('compare', () => {
  it('lines documents up, shows what was computed from the text and names missing evidence', async () => {
    const seen: CompareIn[] = []
    server.use(threeDocuments, compareReturns(makeCompare(), seen))
    renderApp('/c/c1/compare?q=notice+period&docs=d1,d2,d3')

    const alignment = await screen.findByRole('article', { name: 'Alignment 1' })
    expect(seen[0]).toEqual({ question: 'notice period', document_ids: ['d1', 'd2', 'd3'], interpret: true })

    // One summary cell per document; the one without evidence says so explicitly.
    const summaries = screen.getAllByTestId('compare-document')
    expect(summaries).toHaveLength(3)
    expect(within(summaries[0]).getByText('2 relevant passages')).toBeInTheDocument()
    expect(within(summaries[2]).getByText('Pricing sheet')).toBeInTheDocument()
    expect(within(summaries[2]).getByText('No relevant passage found in this document.')).toBeInTheDocument()

    // Paired passages, plus an explicit cell for the document with nothing to pair.
    expect(within(alignment).getByRole('button', { name: /terminate with 30 days notice/ })).toBeInTheDocument()
    expect(within(alignment).getByRole('button', { name: /terminate with 60 days notice/ })).toBeInTheDocument()
    expect(within(alignment).getByText('No relevant passage found in this document.')).toBeInTheDocument()
    expect(within(alignment).getByText('Similarity 0.93')).toBeInTheDocument()

    expect(within(alignment).getByRole('heading', { name: 'Computed from text' })).toBeInTheDocument()
    expect(within(alignment).getByText('Termination requires written notice.')).toBeInTheDocument()
    expect(within(alignment).getByRole('heading', { name: 'Only in Master agreement' }).parentElement).toHaveTextContent('Notice may be sent by email.')

    const table = within(alignment).getByRole('table', { name: 'Numbers that differ' })
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Context', 'Master agreement', 'Service addendum'])
    const row = within(table).getByRole('row', { name: /terminate with … days notice/ })
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['30', '60'])

    const unaligned = screen.getByRole('region', { name: 'Passages without a counterpart' })
    expect(within(unaligned).getByRole('button', { name: /Fees are payable within 14 days/ })).toBeInTheDocument()

    // No LLM: nothing is presented as interpretation.
    expect(screen.queryByText('Model interpretation')).not.toBeInTheDocument()
  })

  it('keeps the model interpretation visually and verbally separate', async () => {
    server.use(
      http.get('/api/system', () => HttpResponse.json(makeSystem({ llm_configured: true, llm_model: 'gpt-test' }))),
      threeDocuments,
      compareReturns(
        makeCompare({
          llm_model: 'gpt-test',
          interpretation: [{ text: 'The addendum doubles the notice period.', citations: [1, 2], supported: true }],
        }),
      ),
    )
    const { user } = renderApp('/c/c1/compare?q=notice+period&docs=d1,d2,d3')

    const panel = await screen.findByRole('region', { name: 'Model interpretation' })
    expect(within(panel).getByText('Generated')).toBeInTheDocument()
    expect(within(panel).getByText(/Written by gpt-test\. This is the model’s reading of the passages\s+below, not a computed result/)).toBeInTheDocument()
    expect(within(panel).getByTestId('answer-text')).toHaveTextContent('The addendum doubles the notice period.')
    expect(within(panel).queryByText('Computed from text')).not.toBeInTheDocument()

    await user.click(within(panel).getByRole('button', { name: 'Citation 2: show the cited passage' }))
    expect(document.getElementById('evidence-2')).toHaveFocus()
  })

  it('offers only indexed documents and needs at least two before comparing', async () => {
    let requests = 0
    server.use(
      threeDocuments,
      http.post('/api/compare', () => {
        requests += 1
        return HttpResponse.json(makeCompare())
      }),
    )
    const { user } = renderApp('/c/c1/compare?docs=d1')

    expect(await screen.findByText('1 selected. Choose 2 to 4.')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'What to compare' }), 'notice period')
    expect(screen.getByRole('button', { name: 'Compare' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: /^Documents:/ }))
    expect(await screen.findByRole('menuitemcheckbox', { name: 'Master agreement' })).toBeChecked()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Draft (still indexing)' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Service addendum' }))
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', { name: 'Compare' }))
    expect(await screen.findByRole('article', { name: 'Alignment 1' })).toBeInTheDocument()
    expect(requests).toBe(1)
  })

  it('explains why a workspace with one indexed document cannot be compared', async () => {
    renderApp('/c/c1/compare')
    expect(await screen.findByRole('heading', { name: 'Comparing needs at least two indexed documents' })).toBeInTheDocument()
  })
})
