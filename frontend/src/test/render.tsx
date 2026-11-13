import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'

import { AppProviders, createAppQueryClient } from '@/App'
import { routes } from '@/router'

/** Mounts the real route tree and providers at `path`, backed by the MSW handlers. */
export function renderApp(path = '/') {
  const queryClient = createAppQueryClient()
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  const user = userEvent.setup()
  render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  )
  return { router, user, queryClient }
}
