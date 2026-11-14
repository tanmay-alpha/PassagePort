import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderApp } from '@/test/render'
import { setViewport } from '@/test/viewport'

describe('shell navigation', () => {
  it('uses / to navigate to workspace search and focus its query', async () => {
    const { user, router } = renderApp('/c/c1')
    await screen.findByRole('heading', { level: 1, name: 'Contracts' })
    await user.keyboard('/')

    const input = await screen.findByRole('searchbox', { name: 'Search Contracts' })
    await waitFor(() => expect(input).toHaveFocus())
    expect(router.state.location.pathname).toBe('/c/c1/search')
    expect(input).toHaveValue('')
  })

  it('selects an existing query with / but leaves slashes typed in a field alone', async () => {
    const { user } = renderApp('/c/c1/search')
    const input = await screen.findByRole('searchbox', { name: 'Search Contracts' })
    await user.type(input, 'contract')
    await user.keyboard('/')
    expect(input).toHaveValue('contract/')
    await user.click(screen.getByRole('heading', { level: 1, name: 'Search' }))
    await user.keyboard('/')

    expect(input).toHaveFocus()
    expect((input as HTMLInputElement).selectionStart).toBe(0)
    expect((input as HTMLInputElement).selectionEnd).toBe('contract/'.length)
    expect(input).toHaveValue('contract/')
  })

  it('opens mobile navigation, navigates and closes the drawer', async () => {
    setViewport('mobile')
    const { user, router } = renderApp('/c/c1')
    await screen.findByRole('heading', { level: 1, name: 'Contracts' })
    expect(screen.queryByRole('complementary', { name: 'Sidebar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Workspace' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))

    const drawer = await screen.findByRole('dialog', { name: 'Navigation' })
    expect(within(drawer).getByRole('navigation', { name: 'Workspace' })).toBeInTheDocument()
    await user.click(within(drawer).getByRole('link', { name: 'Search' }))
    expect(await screen.findByRole('searchbox', { name: 'Search Contracts' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument())
    expect(router.state.location.pathname).toBe('/c/c1/search')
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeInTheDocument()
  })

  it('focuses workspace search from the mobile header', async () => {
    setViewport('mobile')
    const { user, router } = renderApp('/c/c1')
    await screen.findByRole('heading', { level: 1, name: 'Contracts' })
    await user.click(screen.getByRole('button', { name: 'Search this workspace' }))

    const input = await screen.findByRole('searchbox', { name: 'Search Contracts' })
    await waitFor(() => expect(input).toHaveFocus())
    expect(router.state.location.pathname).toBe('/c/c1/search')
  })
})
