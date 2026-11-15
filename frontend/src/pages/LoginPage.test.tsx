import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { makeSession, signedOutSession } from '@/test/fixtures'
import { renderApp } from '@/test/render'
import { apiError, server } from '@/test/server'

describe('account authentication errors', () => {
  it.each([
    { action: 'login', status: 401, message: 'Invalid username or password.', title: 'Sign-in failed.' },
    { action: 'signup', status: 409, message: 'Username already exists.', title: 'The account could not be created.' },
    { action: 'signup', status: 403, message: 'Invalid signup code.', title: 'The account could not be created.' },
  ])('shows $action API errors ($status) and allows correction', async ({ action, status, message, title }) => {
    const requests: unknown[] = []
    const csrf: Array<string | null> = []
    server.use(
      http.get('/api/session', () => HttpResponse.json(signedOutSession({ signup_requires_code: true }))),
      http.post(`/api/auth/${action}`, async ({ request }) => {
        requests.push(await request.json())
        csrf.push(request.headers.get('X-PassagePort-CSRF'))
        return apiError(status, 'authentication_failed', message)
      }),
    )
    const { user, router } = renderApp('/login?next=%2Fsettings')
    await screen.findByRole('heading', { name: 'Sign in to PassagePort' })
    if (action === 'signup') await user.click(screen.getByRole('tab', { name: 'Create account' }))
    await user.type(screen.getByLabelText('Username'), 'reader')
    await user.type(screen.getByLabelText('Password'), 'a-long-password')
    if (action === 'signup') await user.type(screen.getByLabelText('Signup code'), 'invite-code')
    const submit = screen.getByRole('button', { name: action === 'signup' ? 'Create account' : 'Sign in' })
    await user.click(submit)

    expect(await screen.findByText(title)).toBeInTheDocument()
    expect(screen.getByText(message)).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
    expect(screen.getByLabelText('Username')).toHaveValue('reader')
    expect(submit).toBeEnabled()
    expect(requests).toEqual([{ username: 'reader', password: 'a-long-password', ...(action === 'signup' ? { signup_code: 'invite-code' } : {}) }])
    expect(csrf).toEqual(['1'])

    await user.clear(screen.getByLabelText('Username'))
    await user.type(screen.getByLabelText('Username'), 'other_reader')
    await user.click(submit)
    await screen.findByText(message)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual({ username: 'other_reader', password: 'a-long-password', ...(action === 'signup' ? { signup_code: 'invite-code' } : {}) })
  })
})

describe('account authentication success', () => {
  it.each([
    { next: '/settings', expected: '/settings', heading: 'Settings and status' },
    { next: '//example.com', expected: '/', heading: 'Workspaces' },
    { next: '/\\example.com', expected: '/', heading: 'Workspaces' },
    { next: '/login?next=/settings', expected: '/', heading: 'Workspaces' },
  ])('signs in and safely redirects $next to $expected', async ({ next, expected, heading }) => {
    server.use(
      http.get('/api/session', () => HttpResponse.json(signedOutSession())),
      http.post('/api/auth/login', () => HttpResponse.json(makeSession({ auth_mode: 'accounts' }))),
      http.get('/api/auth/tokens', () => HttpResponse.json([])),
    )
    const { user, router } = renderApp(`/login?next=${encodeURIComponent(next)}`)
    await user.type(await screen.findByLabelText('Username'), 'reader')
    await user.type(screen.getByLabelText('Password'), 'a-long-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
    await waitFor(() => expect(router.state.location.pathname).toBe(expected))
  })

  it('continues as a guest only when enabled and updates the shared session', async () => {
    server.use(
      http.get('/api/session', () => HttpResponse.json(signedOutSession({ guests_enabled: true, signup_enabled: false }))),
      http.post('/api/auth/guest', () => HttpResponse.json(makeSession({
        auth_mode: 'accounts',
        user: { id: 'guest1', username: 'guest', is_guest: true },
      }))),
    )
    const { user, queryClient } = renderApp('/login')
    expect(await screen.findByText(/New accounts are disabled/)).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Create account' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Continue as guest' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Workspaces' })).toBeInTheDocument()
    expect(queryClient.getQueryData(['session'])).toMatchObject({ authenticated: true, user: { is_guest: true } })
  })
})
