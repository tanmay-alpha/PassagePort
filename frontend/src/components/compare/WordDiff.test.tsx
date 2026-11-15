import { screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { makeCompare, makeDocument } from '@/test/fixtures'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

describe('compare word diff', () => {
  it('marks removed and added words inline, by shape and for screen readers, and emphasises numbers', async () => {
    server.use(
      http.get('/api/collections/c1/documents', () =>
        HttpResponse.json([makeDocument({ id: 'd1' }), makeDocument({ id: 'd2', title: 'Service addendum' }), makeDocument({ id: 'd3', title: 'Pricing sheet' })]),
      ),
      http.post('/api/compare', () => HttpResponse.json(makeCompare())),
    )
    renderApp('/c/c1/compare?q=notice+period&docs=d1,d2,d3')

    const alignment = (await screen.findAllByTestId('alignment'))[0]
    const diff = within(alignment).getByTestId('word-diff')
    expect(diff).toHaveTextContent('Master agreementcompared withService addendum')
    expect(diff).toHaveTextContent('1 word removed · 1 word added · 1 number change')

    const removed = diff.querySelector('del')
    const added = diff.querySelector('ins')
    expect(removed).toHaveTextContent('[removed number: 30]')
    expect(added).toHaveTextContent('[added number: 60]')
    expect(removed).toHaveClass('pp-diff-removed', 'pp-diff-number')
    expect(added).toHaveClass('pp-diff-added', 'pp-diff-number')
    // The unchanged words stay plain text around the change.
    expect(diff.querySelector('p')?.textContent).toBe(
      'Either party may terminate with [removed number: 30][added number: 60] days notice.',
    )

    // Values in the numbers table are emphasised too.
    const numbers = within(alignment).getByRole('table', { name: 'Numbers that differ' })
    expect(within(numbers).getByText('60')).toHaveClass('pp-diff-number')
  })

  it('does not diff passages that are word for word the same', async () => {
    const compare = makeCompare()
    compare.alignments[0].identical = true
    server.use(
      http.get('/api/collections/c1/documents', () =>
        HttpResponse.json([makeDocument({ id: 'd1' }), makeDocument({ id: 'd2', title: 'Service addendum' })]),
      ),
      http.post('/api/compare', () => HttpResponse.json(compare)),
    )
    renderApp('/c/c1/compare?q=notice+period&docs=d1,d2')

    const alignment = (await screen.findAllByTestId('alignment'))[0]
    expect(within(alignment).getByText('The aligned passages are word for word the same.')).toBeInTheDocument()
    expect(within(alignment).queryByTestId('word-diff')).not.toBeInTheDocument()
  })
})
