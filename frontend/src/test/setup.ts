import '@testing-library/jest-dom/vitest'

import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'

import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'

import { reportReachability } from '@/lib/connectivity'

import { server } from './server'
import { setViewport } from './viewport'

// Browser APIs jsdom does not implement but Radix and the viewer rely on.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.scrollTo ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}

// MSW models intercepted requests with Node's fetch classes, which cannot read jsdom's own
// File/Blob/FormData (a multipart upload would arrive as an empty, unnamed blob). Use Node's
// implementations in tests so the handlers see the bytes the browser would send.
const nativeForm = await new Response(new URLSearchParams()).formData()
Object.assign(globalThis, { Blob: NodeBlob, File: NodeFile, FormData: nativeForm.constructor })

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))

afterEach(() => {
  cleanup()
  server.resetHandlers()
  window.localStorage.clear()
  delete document.documentElement.dataset.theme
  reportReachability(true)
  setViewport('desktop')
})

afterAll(() => server.close())

setViewport('desktop')
