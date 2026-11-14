import '@testing-library/jest-dom/vitest'

import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'

import { cleanup, configure } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'

import { reportReachability } from '@/lib/connectivity'

import { server } from './server'
import { setViewport } from './viewport'

// Cold lazy-route imports can exceed one second on Windows when test workers run together.
configure({ asyncUtilTimeout: 5000 })

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

// Fetch needs Node's multipart implementation, whereas React's form handling constructs
// FormData with an HTMLFormElement (an overload Node does not support). Keep both paths.
const BrowserFormData = globalThis.FormData
const nativeForm = await new Response(new URLSearchParams()).formData()
const FetchFormData = new Proxy(nativeForm.constructor as typeof FormData, {
  construct(target, args) {
    return args[0] instanceof HTMLFormElement
      ? Reflect.construct(BrowserFormData, args)
      : Reflect.construct(target, args)
  },
})
Object.assign(globalThis, { Blob: NodeBlob, File: NodeFile, FormData: FetchFormData })

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
