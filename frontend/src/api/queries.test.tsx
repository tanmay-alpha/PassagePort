import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { createAppQueryClient } from '@/App'
import {
  makeAsk,
  makeCollection,
  makeCompare,
  makeDocument,
  makeLab,
  makeSearch,
  makeSystem,
} from '@/test/fixtures'
import { server } from '@/test/server'

import {
  keys,
  useAsk,
  useCollections,
  useCompare,
  useDocument,
  useDocuments,
  useLabSearch,
  useSearch,
  useSystem,
} from './queries'

const searchInput = { collection_id: 'c1', query: 'notice' }
const askInput = { collection_id: 'c1', question: 'What notice is required?' }
const compareInput = { document_ids: ['d1', 'd2'], question: 'Compare notice periods' }
const labInput = { collection_id: 'c1', query: 'notice' }
const retrievalData = [
  { queryKey: ['search', searchInput], data: makeSearch() },
  { queryKey: ['ask', askInput], data: makeAsk() },
  { queryKey: ['compare', compareInput], data: makeCompare() },
  { queryKey: ['lab', labInput], data: makeLab() },
] as const

function createHarness() {
  const queryClient = createAppQueryClient()
  // Model returning to a stale document query without waiting for wall-clock expiry.
  queryClient.setQueryDefaults(['documents'], { staleTime: 0 })
  queryClient.setQueryDefaults(['document'], { staleTime: 0 })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper }
}

function cacheDerivedData(queryClient: QueryClient) {
  for (const { queryKey, data } of retrievalData) queryClient.setQueryData(queryKey, data)
  queryClient.setQueryData(keys.collections, [makeCollection()])
  queryClient.setQueryData(keys.system, makeSystem())
}

function expectDerivedInvalidated(queryClient: QueryClient) {
  for (const { queryKey, data } of retrievalData) {
    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryData(queryKey)).toEqual(data)
  }
  expect(queryClient.getQueryState(keys.collections)?.isInvalidated).toBe(true)
  expect(queryClient.getQueryState(keys.system)?.isInvalidated).toBe(true)
}

describe('shared indexing completion', () => {
  it('invalidates inactive retrieval and counts when one document completes while another still processes', async () => {
    const { queryClient, wrapper } = createHarness()
    cacheDerivedData(queryClient)
    queryClient.setQueryData(keys.documents('c1'), [
      makeDocument({ id: 'd1', status: 'processing' }),
      makeDocument({ id: 'd2', status: 'processing' }),
    ])
    server.use(http.get('/api/collections/c1/documents', () => HttpResponse.json([
      makeDocument({ id: 'd1', status: 'indexed' }),
      makeDocument({ id: 'd2', status: 'processing' }),
    ])))

    const { result } = renderHook(() => useDocuments('c1'), { wrapper })

    await waitFor(() => expect(result.current.data?.[0].status).toBe('indexed'))
    expect(result.current.data?.[1].status).toBe('processing')
    expectDerivedInvalidated(queryClient)
  })

  it('refetches active search, ask, compare, lab and counts without removing their queries', async () => {
    const { queryClient, wrapper } = createHarness()
    let completed = false
    const calls = { search: 0, ask: 0, compare: 0, lab: 0, collections: 0, system: 0 }
    server.use(
      http.get('/api/collections/c1/documents', () => HttpResponse.json([
        makeDocument({ status: completed ? 'indexed' : 'processing' }),
      ])),
      http.post('/api/search', () => {
        calls.search += 1
        return HttpResponse.json(makeSearch({ query: `search-${calls.search}` }))
      }),
      http.post('/api/ask', () => {
        calls.ask += 1
        return HttpResponse.json(makeAsk({ question: `ask-${calls.ask}` }))
      }),
      http.post('/api/compare', () => {
        calls.compare += 1
        return HttpResponse.json(makeCompare({ question: `compare-${calls.compare}` }))
      }),
      http.post('/api/lab/search', () => {
        calls.lab += 1
        return HttpResponse.json(makeLab({ query: `lab-${calls.lab}` }))
      }),
      http.get('/api/collections', () => {
        calls.collections += 1
        return HttpResponse.json([makeCollection({ indexed_count: completed ? 1 : 0, processing_count: completed ? 0 : 1 })])
      }),
      http.get('/api/system', () => {
        calls.system += 1
        return HttpResponse.json(makeSystem({ pending_jobs: completed ? 0 : 1 }))
      }),
    )
    const { result } = renderHook(() => ({
      documents: useDocuments('c1'),
      search: useSearch(searchInput),
      ask: useAsk(askInput),
      compare: useCompare(compareInput),
      lab: useLabSearch(labInput),
      collections: useCollections(),
      system: useSystem(),
    }), { wrapper })
    await waitFor(() => {
      expect(result.current.documents.data?.[0].status).toBe('processing')
      expect(result.current.search.data?.query).toBe('search-1')
      expect(result.current.ask.data?.question).toBe('ask-1')
      expect(result.current.compare.data?.question).toBe('compare-1')
      expect(result.current.lab.data?.query).toBe('lab-1')
      expect(result.current.collections.data?.[0].indexed_count).toBe(0)
      expect(result.current.system.data?.pending_jobs).toBe(1)
    })
    const originalQueries = retrievalData.map(({ queryKey }) => queryClient.getQueryCache().find({ queryKey }))

    completed = true
    await act(async () => { await result.current.documents.refetch() })

    await waitFor(() => {
      expect(result.current.search.data?.query).toBe('search-2')
      expect(result.current.ask.data?.question).toBe('ask-2')
      expect(result.current.compare.data?.question).toBe('compare-2')
      expect(result.current.lab.data?.query).toBe('lab-2')
      expect(result.current.collections.data?.[0].indexed_count).toBe(1)
      expect(result.current.system.data?.pending_jobs).toBe(0)
    })
    expect(calls).toEqual({ search: 2, ask: 2, compare: 2, lab: 2, collections: 2, system: 2 })
    retrievalData.forEach(({ queryKey }, index) => {
      expect(queryClient.getQueryCache().find({ queryKey })).toBe(originalQueries[index])
    })
  })

  it.each(['indexed', 'failed'] as const)('detects cached list completion after unmount and remount: %s', async (status) => {
    const { queryClient, wrapper } = createHarness()
    let document = makeDocument({ status: 'uploaded' })
    server.use(http.get('/api/collections/c1/documents', () => HttpResponse.json([document])))
    const first = renderHook(() => useDocuments('c1'), { wrapper })
    await waitFor(() => expect(first.result.current.data?.[0].status).toBe('uploaded'))
    first.unmount()
    cacheDerivedData(queryClient)
    document = makeDocument({ status })

    const second = renderHook(() => useDocuments('c1'), { wrapper })

    await waitFor(() => expect(second.result.current.data?.[0].status).toBe(status))
    expectDerivedInvalidated(queryClient)
    // An unchanged terminal response is not a second completion.
    cacheDerivedData(queryClient)
    await act(async () => { await second.result.current.refetch() })
    for (const { queryKey } of retrievalData) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false)
    }
    expect(queryClient.getQueryState(keys.collections)?.isInvalidated).toBe(false)
    expect(queryClient.getQueryState(keys.system)?.isInvalidated).toBe(false)
  })

  it.each(['indexed', 'failed'] as const)('detects cached individual completion after unmount and remount: %s', async (status) => {
    const { queryClient, wrapper } = createHarness()
    let document = makeDocument({ status: 'processing' })
    server.use(http.get('/api/documents/d1', () => HttpResponse.json(document)))
    const first = renderHook(() => useDocument('d1'), { wrapper })
    await waitFor(() => expect(first.result.current.data?.status).toBe('processing'))
    first.unmount()
    cacheDerivedData(queryClient)
    document = makeDocument({ status })

    const second = renderHook(() => useDocument('d1'), { wrapper })

    await waitFor(() => expect(second.result.current.data?.status).toBe(status))
    expectDerivedInvalidated(queryClient)
  })

  it('detects completion in the viewer using the document list cached before navigation', async () => {
    const { queryClient, wrapper } = createHarness()
    cacheDerivedData(queryClient)
    queryClient.setQueryData(keys.documents('c1'), [makeDocument({ status: 'processing' })])
    server.use(http.get('/api/documents/d1', () => HttpResponse.json(makeDocument())))

    const { result } = renderHook(() => useDocument('d1'), { wrapper })

    await waitFor(() => expect(result.current.data?.status).toBe('indexed'))
    expectDerivedInvalidated(queryClient)
  })

  it('detects completion in a list using the individual document cached before navigation', async () => {
    const { queryClient, wrapper } = createHarness()
    cacheDerivedData(queryClient)
    queryClient.setQueryData(keys.document('d1'), makeDocument({ status: 'processing' }))
    server.use(http.get('/api/collections/c1/documents', () => HttpResponse.json([makeDocument()])))

    const { result } = renderHook(() => useDocuments('c1'), { wrapper })

    await waitFor(() => expect(result.current.data?.[0].status).toBe('indexed'))
    expectDerivedInvalidated(queryClient)
  })

  it('does not invalidate for uploaded-to-processing transitions or previously unseen indexed documents', async () => {
    const { queryClient, wrapper } = createHarness()
    cacheDerivedData(queryClient)
    queryClient.setQueryData(keys.documents('c1'), [makeDocument({ status: 'uploaded' })])
    server.use(http.get('/api/collections/c1/documents', () => HttpResponse.json([
      makeDocument({ status: 'processing' }),
      makeDocument({ id: 'd2', status: 'indexed' }),
    ])))

    const { result } = renderHook(() => useDocuments('c1'), { wrapper })

    await waitFor(() => expect(result.current.data?.[0].status).toBe('processing'))
    for (const { queryKey } of retrievalData) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false)
    }
    expect(queryClient.getQueryState(keys.collections)?.isInvalidated).toBe(false)
    expect(queryClient.getQueryState(keys.system)?.isInvalidated).toBe(false)
  })
})
