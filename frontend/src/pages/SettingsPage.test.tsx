import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'

import type { ApiTokenOut } from '@/api/types'
import { THEME_STORAGE_KEY } from '@/lib/theme'
import { makeSession, makeSystem } from '@/test/fixtures'
import { renderApp } from '@/test/render'
import { apiError, server } from '@/test/server'

describe('settings', () => {
  it('persists the selected theme across navigation and clears an explicit preference for System', async () => {
    const { user, router } = renderApp('/settings')
    await user.click(await screen.findByRole('radio', { name: 'Dark' }))
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')

    await user.click(screen.getByRole('link', { name: 'PassagePort home' }))
    await screen.findByRole('heading', { name: 'Workspaces' })
    await router.navigate('/settings')
    expect(await screen.findByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('radio', { name: 'Light' }))
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    await user.click(screen.getByRole('radio', { name: 'System' }))
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Following your system (light).')).toBeInTheDocument()
  })

  it('creates, reveals once, copies and revokes an accounts-mode API token', async () => {
    let tokens: ApiTokenOut[] = []
    const mutations: unknown[] = []
    server.use(
      http.get('/api/session', () => HttpResponse.json(makeSession({ auth_mode: 'accounts' }))),
      http.get('/api/system', () => HttpResponse.json(makeSystem({ auth_mode: 'accounts' }))),
      http.get('/api/auth/tokens', () => HttpResponse.json(tokens)),
      http.post('/api/auth/tokens', async ({ request }) => {
        mutations.push({ body: await request.json(), csrf: request.headers.get('X-PassagePort-CSRF') })
        const token = { id: 't1', name: 'Laptop', created_at: '2026-05-01T10:00:00Z', token: null }
        tokens = [token]
        return HttpResponse.json({ ...token, token: 'pp_secret-only-once' }, { status: 201 })
      }),
      http.delete('/api/auth/tokens/t1', ({ request }) => {
        mutations.push({ method: request.method, csrf: request.headers.get('X-PassagePort-CSRF') })
        tokens = []
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { user } = renderApp('/settings')
    const writeClipboard = vi.spyOn(navigator.clipboard, 'writeText')
    expect(await screen.findByText('No API tokens yet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled()
    await user.type(screen.getByLabelText('New token name'), '  Laptop  ')
    await user.click(screen.getByRole('button', { name: 'Create token' }))

    expect(await screen.findByLabelText('New API token')).toHaveValue('pp_secret-only-once')
    expect(screen.getByLabelText('New token name')).toHaveValue('')
    expect(await screen.findByRole('button', { name: 'Revoke token Laptop' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(writeClipboard).toHaveBeenCalledWith('pp_secret-only-once')
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByLabelText('New API token')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('pp_secret-only-once')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Revoke token Laptop' }))
    const dialog = await screen.findByRole('dialog', { name: 'Revoke “Laptop”?' })
    expect(within(dialog).getByText(/Anything using this token stops working immediately/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Revoke token' }))
    expect(await screen.findByText('No API tokens yet.')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mutations).toEqual([{ body: { name: 'Laptop' }, csrf: '1' }, { method: 'DELETE', csrf: '1' }])
  })

  it('shows token creation API errors without revealing a secret', async () => {
    server.use(
      http.get('/api/session', () => HttpResponse.json(makeSession({ auth_mode: 'accounts' }))),
      http.get('/api/auth/tokens', () => HttpResponse.json([])),
      http.post('/api/auth/tokens', () => apiError(409, 'conflict', 'A token with this name already exists.')),
    )
    const { user } = renderApp('/settings')
    await user.type(await screen.findByLabelText('New token name'), 'Laptop')
    await user.click(screen.getByRole('button', { name: 'Create token' }))
    expect(await screen.findByText('A token with this name already exists.')).toBeInTheDocument()
    expect(screen.getByLabelText('New token name')).toHaveValue('Laptop')
    expect(screen.queryByLabelText('New API token')).not.toBeInTheDocument()
  })
})
