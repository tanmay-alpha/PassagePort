import { screen, waitFor, within } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { makeCollection, makeDocument, makeSearch } from '@/test/fixtures'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const documents = [
  makeDocument({ id: 'd1', title: 'Master agreement' }),
  makeDocument({ id: 'd2', title: 'Service addendum', filename: 'addendum-2025.pdf', kind: 'pdf', locator_kind: 'page' }),
]

function mockWorkspaces() {
  server.use(
    http.get('/api/collections', () => HttpResponse.json([makeCollection(), makeCollection({ id: 'c2', name: 'Research papers' })])),
    http.get('/api/collections/c1/documents', () => HttpResponse.json(documents)),
  )
}

async function openPalette(user: UserEvent) {
  await user.keyboard('{Control>}k{/Control}')
  const dialog = await screen.findByRole('dialog', { name: 'Command menu' })
  const input = within(dialog).getByRole('combobox', { name: 'Search commands, documents and workspaces' })
  await waitFor(() => expect(input).toHaveFocus())
  return { dialog, input }
}

function activeOption(input: HTMLElement): HTMLElement {
  const id = input.getAttribute('aria-activedescendant')
  const option = id ? document.getElementById(id) : null
  if (!option) throw new Error('no active option')
  return option
}

describe('command palette', () => {
  it('opens with Ctrl+K, filters documents by title or file name and opens one with the keyboard', async () => {
    mockWorkspaces()
    const { user, router } = renderApp('/c/c1')
    await screen.findByRole('heading', { level: 1, name: 'Contracts' })

    const { dialog, input } = await openPalette(user)
    expect(input).toHaveAttribute('aria-expanded', 'true')
    const listbox = within(dialog).getByRole('listbox', { name: 'Commands' })
    expect(input).toHaveAttribute('aria-controls', listbox.id)
    // Empty query: screens of the current workspace come first.
    expect(activeOption(input)).toHaveTextContent('Library')
    expect(within(listbox).getByRole('group', { name: 'Workspaces' })).toBeInTheDocument()

    // Matched by file name only: a weak match, so running the text as a search stays first.
    await user.type(input, '2025')
    const documentsGroup = await within(listbox).findByRole('group', { name: 'Documents in Contracts' })
    expect(within(documentsGroup).getAllByRole('option').map((option) => option.textContent)).toEqual([expect.stringContaining('Service addendum')])
    expect(within(listbox).queryByRole('option', { name: /Master agreement/ })).not.toBeInTheDocument()
    expect(activeOption(input)).toHaveTextContent('Search for “2025”')
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(activeOption(input)).toHaveTextContent('Service addendum')
    expect(activeOption(input)).toHaveAttribute('aria-selected', 'true')

    // A title match is what the user meant: it is selected first.
    await user.clear(input)
    await user.type(input, 'addendum')
    expect(activeOption(input)).toHaveTextContent('Service addendum')
    expect(within(listbox).getByRole('option', { name: /Search for “addendum”/ })).toBeInTheDocument()
    await user.keyboard('{Enter}')

    await waitFor(() => expect(router.state.location.pathname).toBe('/d/d2'))
    expect(screen.queryByRole('dialog', { name: 'Command menu' })).not.toBeInTheDocument()
  })

  it('runs the typed text as a search in the current workspace', async () => {
    mockWorkspaces()
    const seen: unknown[] = []
    server.use(
      http.post('/api/search', async ({ request }) => {
        seen.push(await request.json())
        return HttpResponse.json(makeSearch({ query: 'notice period' }))
      }),
    )
    const { user, router } = renderApp('/c/c1')
    await screen.findByRole('heading', { level: 1, name: 'Contracts' })

    const { input } = await openPalette(user)
    await user.type(input, 'notice period{Enter}')

    await waitFor(() => expect(router.state.location.pathname).toBe('/c/c1/search'))
    expect(router.state.location.search).toBe('?q=notice%20period')
    expect(await screen.findByRole('searchbox', { name: 'Search Contracts' })).toHaveValue('notice period')
    await waitFor(() => expect(seen).toHaveLength(1))
  })

  it('wraps arrow keys, runs actions, and closes with Escape returning focus', async () => {
    mockWorkspaces()
    const { user } = renderApp('/c/c1')
    await screen.findByRole('heading', { level: 1, name: 'Contracts' })
    const opener = screen.getByRole('button', { name: 'Search or jump to…' })
    await user.click(opener)
    const dialog = await screen.findByRole('dialog', { name: 'Command menu' })
    const input = within(dialog).getByRole('combobox')
    const options = within(dialog).getAllByRole('option')

    await user.keyboard('{ArrowUp}')
    expect(activeOption(input)).toBe(options.at(-1))
    await user.keyboard('{ArrowDown}')
    expect(activeOption(input)).toBe(options[0])

    await user.type(input, 'dark theme')
    expect(activeOption(input)).toHaveTextContent('Switch to dark theme')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
    await waitFor(() => expect(opener).toHaveFocus())

    await user.keyboard('{Control>}k{/Control}')
    await screen.findByRole('dialog', { name: 'Command menu' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command menu' })).not.toBeInTheDocument())
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('says when nothing matches', async () => {
    server.use(http.get('/api/collections', () => HttpResponse.json([])))
    const { user } = renderApp('/')
    await screen.findByRole('heading', { level: 1, name: 'Welcome to PassagePort' })
    const { dialog, input } = await openPalette(user)
    await user.type(input, 'zzzz')
    // Outside a workspace there is no search to fall back on.
    expect(within(dialog).queryByRole('option', { name: /Search for/ })).not.toBeInTheDocument()
    expect(within(dialog).getByText('Nothing matches “zzzz”.')).toBeInTheDocument()
    expect(input).not.toHaveAttribute('aria-activedescendant')
  })
})
