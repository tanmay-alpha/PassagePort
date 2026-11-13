import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { AskIn, AskOut } from '@/api/types'
import { makeAsk, makeDocument, makeEvidence } from '@/test/fixtures'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

function askReturns(response: AskOut, seen: AskIn[] = []) {
  return http.post('/api/ask', async ({ request }) => {
    seen.push((await request.json()) as AskIn)
    return HttpResponse.json(response)
  })
}

const viewerHandlers = [
  http.get('/api/documents/:id', ({ params }) => HttpResponse.json(makeDocument({ id: String(params.id) }))),
  http.get('/api/documents/:id/outline', ({ params }) =>
    HttpResponse.json({ document_id: params.id, locator_kind: 'section', items: [{ page_number: 2, page_label: 'Termination' }] }),
  ),
  http.get('/api/documents/:id/pages/:page', ({ params }) =>
    HttpResponse.json({
      document_id: params.id,
      page_number: Number(params.page),
      page_label: 'Termination',
      page_count: 3,
      text: 'Either party may terminate with 30 days notice. Notice must be given in writing.',
    }),
  ),
]

describe('ask', () => {
  it('labels an extractive answer and points to how generated answers are enabled', async () => {
    const seen: AskIn[] = []
    server.use(askReturns(makeAsk(), seen))
    const { user } = renderApp('/c/c1/ask')

    await user.type(await screen.findByRole('textbox', { name: 'Your question' }), 'What is the notice period?{Enter}')

    const answer = await screen.findByRole('region', { name: 'Answer' })
    expect(seen[0]).toEqual({ question: 'What is the notice period?', collection_id: 'c1', document_ids: null })
    expect(within(answer).getByText('Excerpts from your documents')).toBeInTheDocument()
    expect(within(answer).getByText(/No language model is configured, so these are verbatim sentences/)).toBeInTheDocument()
    expect(within(answer).getByRole('link', { name: 'How to enable generated answers' })).toHaveAttribute('href', '/settings#answers')
    expect(within(answer).getByTestId('answer-text')).toHaveTextContent('Either party may terminate with 30 days notice.')
    expect(within(answer).queryByText('Generated answer')).not.toBeInTheDocument()

    // What was checked is available but tucked away.
    await user.click(within(answer).getByText('What was checked'))
    expect(within(answer).getByText('Every sentence is copied verbatim from a cited passage.')).toBeVisible()

    expect(screen.getByRole('heading', { name: 'Evidence' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Open in document viewer/ })).toHaveLength(2)
  })

  it('labels a generated answer, renders it as plain text and flags unsupported sentences', async () => {
    server.use(
      askReturns(
        makeAsk({
          mode: 'generated',
          llm_model: 'gpt-test',
          segments: [
            { text: 'The notice period is 30 days.', citations: [1, 2], supported: true },
            { text: 'It <b>may</b> change **later**.', citations: [], supported: false },
          ],
          checks: ['Every citation refers to a retrieved passage.'],
        }),
      ),
    )
    renderApp('/c/c1/ask?q=What+is+the+notice+period%3F')

    const answer = await screen.findByRole('region', { name: 'Answer' })
    expect(within(answer).getByText('Generated answer')).toBeInTheDocument()
    expect(within(answer).getByText(/Written by gpt-test from the passages below\. It has not been\s+independently fact-checked/)).toBeInTheDocument()

    const text = within(answer).getByTestId('answer-text')
    // Server text is never interpreted as HTML or Markdown.
    expect(text).toHaveTextContent('It <b>may</b> change **later**.')
    expect(text.querySelector('b, strong, em')).toBeNull()

    expect(within(text).getAllByRole('button', { name: /^Citation \d/ })).toHaveLength(2)
    const unsupported = text.querySelector('[data-supported="false"]')
    expect(unsupported).toHaveTextContent('No citation')
    expect(within(answer).getByText(/are not backed by any retrieved passage/)).toBeInTheDocument()
  })

  it('says when there is not enough evidence and still lists what was retrieved', async () => {
    server.use(
      askReturns(
        makeAsk({
          mode: 'insufficient',
          segments: [],
          notice: 'The retrieved passages do not mention this topic clearly enough to answer.',
          evidence: [makeEvidence(1, { text: 'Fees are payable within 14 days.', page_label: 'Fees' })],
        }),
      ),
    )
    renderApp('/c/c1/ask?q=Who+signed+it%3F')

    const answer = await screen.findByRole('region', { name: 'Answer' })
    expect(within(answer).getByText('Not enough evidence')).toBeInTheDocument()
    expect(within(answer).getByText('The retrieved passages do not mention this topic clearly enough to answer.')).toBeInTheDocument()
    expect(within(answer).queryByTestId('answer-text')).not.toBeInTheDocument()

    expect(screen.getByRole('heading', { name: 'What was retrieved' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Fees are payable within 14 days/ })).toBeInTheDocument()
  })

  it('moves focus to the cited evidence and opens it in the viewer when a chip is activated', async () => {
    server.use(
      askReturns(makeAsk({ evidence: [makeEvidence(1, { char_start: 0, char_end: 47 }), makeEvidence(2, { text: 'Notice must be given in writing.', char_start: 48, char_end: 80 })] })),
      ...viewerHandlers,
    )
    const { user, router } = renderApp('/c/c1/ask?q=What+is+the+notice+period%3F')

    await user.click(await screen.findByRole('button', { name: 'Citation 1: show the cited passage' }))

    const evidence = screen.getByRole('button', { name: /^1.*Either party may terminate/ })
    expect(evidence).toHaveFocus()
    expect(evidence).toHaveAttribute('id', 'evidence-1')
    expect(new URLSearchParams(router.state.location.search).get('hit')).toBe('ev1')

    const preview = await screen.findByRole('region', { name: 'Document preview' })
    expect((await within(preview).findByTestId('cited-passage')).textContent).toBe('Either party may terminate with 30 days notice.')
    await waitFor(() => expect(evidence).toHaveAttribute('aria-current', 'true'))
  })

  it('shows the server error and lets the user retry', async () => {
    let attempts = 0
    server.use(
      http.post('/api/ask', () => {
        attempts += 1
        return attempts === 1
          ? HttpResponse.json({ error: { code: 'rate_limited', message: 'Too many requests. Try again in a minute.' } }, { status: 429 })
          : HttpResponse.json(makeAsk())
      }),
    )
    const { user } = renderApp('/c/c1/ask?q=What+is+the+notice+period%3F')

    expect(await screen.findByText('Too many requests. Try again in a minute.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('region', { name: 'Answer' })).toBeInTheDocument()
  })
})
