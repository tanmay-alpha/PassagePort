import '@fontsource-variable/inter'
import '@fontsource-variable/source-serif-4'
import './styles/index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'

import { AppErrorBoundary, AppProviders, createAppQueryClient } from './App'
import { initTheme } from './lib/theme'
import { routes } from './router'

initTheme()

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')

const queryClient = createAppQueryClient()
const router = createBrowserRouter(routes)

createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary>
      <AppProviders queryClient={queryClient}>
        <RouterProvider router={router} />
      </AppProviders>
    </AppErrorBoundary>
  </StrictMode>,
)
