import {
  keepPreviousData,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { api, ApiError } from './client'
import type {
  ApiTokenIn,
  ApiTokenOut,
  AskIn,
  AskOut,
  ChunkOut,
  CollectionIn,
  CollectionOut,
  CollectionPatch,
  CompareIn,
  CompareOut,
  CredentialsIn,
  DocumentOut,
  EvalReport,
  LabIn,
  LabOut,
  OutlineOut,
  PageOut,
  SearchIn,
  SearchOut,
  SessionOut,
  SystemOut,
} from './types'

/** How often lists refresh while something is still being indexed. */
export const INDEXING_POLL_MS = 1500
const RETRIEVAL_STALE_MS = 5 * 60_000
const RETRIEVAL_KEYS = ['search', 'ask', 'compare', 'lab'] as const

export const keys = {
  session: ['session'] as const,
  system: ['system'] as const,
  collections: ['collections'] as const,
  documents: (collectionId: string) => ['documents', collectionId] as const,
  document: (documentId: string) => ['document', documentId] as const,
  outline: (documentId: string) => ['outline', documentId] as const,
  page: (documentId: string, pageNumber: number) => ['page', documentId, pageNumber] as const,
  chunk: (chunkId: string) => ['chunk', chunkId] as const,
  tokens: ['tokens'] as const,
  evaluation: ['evaluation'] as const,
}

const seg = encodeURIComponent

export function isIndexing(document: Pick<DocumentOut, 'status'>): boolean {
  return document.status === 'uploaded' || document.status === 'processing'
}

/** Results computed from the index are outdated once documents change. */
function invalidateRetrieval(queryClient: QueryClient): void {
  for (const key of RETRIEVAL_KEYS) void queryClient.invalidateQueries({ queryKey: [key] })
}

/** Refreshes everything derived from the set of documents (counts, usage, cached results). */
export function invalidateLibrary(queryClient: QueryClient, collectionId?: string): void {
  if (collectionId) void queryClient.invalidateQueries({ queryKey: keys.documents(collectionId) })
  void queryClient.invalidateQueries({ queryKey: keys.collections })
  void queryClient.invalidateQueries({ queryKey: keys.system })
  invalidateRetrieval(queryClient)
}

// ----------------------------------------------------------------------------- session / auth

export function useSession() {
  return useQuery({
    queryKey: keys.session,
    queryFn: ({ signal }) => api<SessionOut>('/session', { signal }),
    staleTime: 60_000,
  })
}

type AuthAction = 'login' | 'signup'

function useSessionMutation<TInput>(request: (input: TInput) => Promise<SessionOut>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: request,
    onSuccess: (session) => {
      // A different user may have signed in: drop everything cached for the previous one.
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== keys.session[0] })
      queryClient.setQueryData(keys.session, session)
    },
  })
}

export function useAuthenticate(action: AuthAction) {
  return useSessionMutation((credentials: CredentialsIn) =>
    api<SessionOut>(`/auth/${action}`, { method: 'POST', body: credentials }),
  )
}

export function useGuestSession() {
  return useSessionMutation((_: void) => api<SessionOut>('/auth/guest', { method: 'POST' }))
}

export function useSignOut() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api<void>('/auth/logout', { method: 'POST' }),
    onSuccess: async () => {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== keys.session[0] })
      await queryClient.invalidateQueries({ queryKey: keys.session })
    },
  })
}

export function useApiTokens(enabled: boolean) {
  return useQuery({
    queryKey: keys.tokens,
    queryFn: ({ signal }) => api<ApiTokenOut[]>('/auth/tokens', { signal }),
    enabled,
  })
}

export function useCreateApiToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ApiTokenIn) => api<ApiTokenOut>('/auth/tokens', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.tokens }),
  })
}

export function useRevokeApiToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (tokenId: string) => api<void>(`/auth/tokens/${seg(tokenId)}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.tokens }),
  })
}

// ----------------------------------------------------------------------------- system

export function useSystem() {
  return useQuery({
    queryKey: keys.system,
    queryFn: ({ signal }) => api<SystemOut>('/system', { signal }),
    staleTime: 30_000,
  })
}

// ----------------------------------------------------------------------------- collections

export function useCollections() {
  return useQuery({
    queryKey: keys.collections,
    queryFn: ({ signal }) => api<CollectionOut[]>('/collections', { signal }),
    // Counts change while documents are being indexed; keep the cards truthful.
    refetchInterval: (query) =>
      query.state.data?.some((collection) => collection.processing_count > 0) ? INDEXING_POLL_MS * 2 : false,
  })
}

export function useCreateCollection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CollectionIn) => api<CollectionOut>('/collections', { method: 'POST', body: input }),
    onSuccess: (created) => {
      queryClient.setQueryData<CollectionOut[]>(keys.collections, (current) =>
        current ? [...current, created].sort((a, b) => a.name.localeCompare(b.name)) : current,
      )
      invalidateLibrary(queryClient)
    },
  })
}

export function useUpdateCollection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: CollectionPatch }) =>
      api<CollectionOut>(`/collections/${seg(id)}`, { method: 'PATCH', body: patch }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.collections }),
  })
}

export function useDeleteCollection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/collections/${seg(id)}`, { method: 'DELETE' }),
    onSuccess: (_result, id) => {
      queryClient.setQueryData<CollectionOut[]>(keys.collections, (current) =>
        current?.filter((collection) => collection.id !== id),
      )
      queryClient.removeQueries({ queryKey: keys.documents(id) })
      invalidateLibrary(queryClient)
    },
  })
}

// ----------------------------------------------------------------------------- documents

export function useDocuments(collectionId: string | undefined) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: keys.documents(collectionId ?? ''),
    queryFn: async ({ signal, queryKey }) => {
      const documents = await api<DocumentOut[]>(`/collections/${seg(collectionId ?? '')}/documents`, { signal })
      // The query cache survives navigation, unlike component-local completion tracking.
      const previous = queryClient.getQueryData<DocumentOut[]>(queryKey)
      const completed = documents.some((document) => {
        const previousDocument = previous?.find((item) => item.id === document.id) ??
          queryClient.getQueryData<DocumentOut>(keys.document(document.id))
        return previousDocument !== undefined && isIndexing(previousDocument) && !isIndexing(document)
      })
      if (completed) invalidateLibrary(queryClient)
      return documents
    },
    enabled: Boolean(collectionId),
    // Poll only while the server is still working on something in this collection.
    refetchInterval: (query) => (query.state.data?.some(isIndexing) ? INDEXING_POLL_MS : false),
  })
}

export function useDocument(documentId: string | undefined) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: keys.document(documentId ?? ''),
    queryFn: async ({ signal, queryKey }) => {
      const document = await api<DocumentOut>(`/documents/${seg(documentId ?? '')}`, { signal })
      const previous = queryClient.getQueryData<DocumentOut>(queryKey) ??
        queryClient.getQueryData<DocumentOut[]>(keys.documents(document.collection_id))?.find((item) => item.id === document.id)
      if (previous !== undefined && isIndexing(previous) && !isIndexing(document)) invalidateLibrary(queryClient)
      return document
    },
    enabled: Boolean(documentId),
    refetchInterval: (query) => (query.state.data && isIndexing(query.state.data) ? INDEXING_POLL_MS : false),
  })
}

function replaceDocument(queryClient: QueryClient, document: DocumentOut): void {
  queryClient.setQueryData(keys.document(document.id), document)
  queryClient.setQueryData<DocumentOut[]>(keys.documents(document.collection_id), (current) =>
    current?.map((item) => (item.id === document.id ? document : item)),
  )
}

export function useRenameDocument() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api<DocumentOut>(`/documents/${seg(id)}`, { method: 'PATCH', body: { title } }),
    onSuccess: (document) => {
      replaceDocument(queryClient, document)
      invalidateRetrieval(queryClient)
    },
  })
}

export function useReindexDocument() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<DocumentOut>(`/documents/${seg(id)}/reindex`, { method: 'POST' }),
    onSuccess: (document) => {
      replaceDocument(queryClient, document)
      invalidateLibrary(queryClient)
    },
  })
}

export function useDeleteDocument() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (document: Pick<DocumentOut, 'id' | 'collection_id'>) =>
      api<void>(`/documents/${seg(document.id)}`, { method: 'DELETE' }),
    onSuccess: (_result, document) => {
      queryClient.setQueryData<DocumentOut[]>(keys.documents(document.collection_id), (current) =>
        current?.filter((item) => item.id !== document.id),
      )
      queryClient.removeQueries({ queryKey: keys.document(document.id) })
      invalidateLibrary(queryClient, document.collection_id)
    },
  })
}

export function useOutline(documentId: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.outline(documentId),
    queryFn: ({ signal }) => api<OutlineOut>(`/documents/${seg(documentId)}/outline`, { signal }),
    enabled,
    staleTime: 60_000,
  })
}

export function usePage(documentId: string, pageNumber: number, enabled: boolean) {
  return useQuery({
    queryKey: keys.page(documentId, pageNumber),
    queryFn: ({ signal }) => api<PageOut>(`/documents/${seg(documentId)}/pages/${pageNumber}`, { signal }),
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  })
}

export function useChunk(chunkId: string | null) {
  return useQuery({
    queryKey: keys.chunk(chunkId ?? ''),
    queryFn: ({ signal }) => api<ChunkOut>(`/chunks/${seg(chunkId ?? '')}`, { signal }),
    enabled: chunkId !== null,
    staleTime: 60_000,
    retry: false,
  })
}

// ----------------------------------------------------------------------------- retrieval

/**
 * Retrieval requests are POSTs but behave like reads, so they are modelled as queries keyed
 * by their full input: the URL can drive them and going back shows the cached result.
 */
function useRetrieval<TInput extends object, TOutput>(
  name: (typeof RETRIEVAL_KEYS)[number],
  path: string,
  input: TInput | null,
  keepPrevious: boolean,
) {
  return useQuery({
    queryKey: [name, input],
    queryFn: ({ signal }) => api<TOutput>(path, { method: 'POST', body: input, signal }),
    enabled: input !== null,
    staleTime: RETRIEVAL_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
    placeholderData: keepPrevious ? keepPreviousData : undefined,
  })
}

export function useSearch(input: SearchIn | null) {
  return useRetrieval<SearchIn, SearchOut>('search', '/search', input, true)
}

export function useAsk(input: AskIn | null) {
  return useRetrieval<AskIn, AskOut>('ask', '/ask', input, false)
}

export function useCompare(input: CompareIn | null) {
  return useRetrieval<CompareIn, CompareOut>('compare', '/compare', input, false)
}

export function useLabSearch(input: LabIn | null) {
  return useRetrieval<LabIn, LabOut>('lab', '/lab/search', input, true)
}

/** Resolves to `null` when the server has no committed evaluation report (404). */
export function useEvaluation() {
  return useQuery({
    queryKey: keys.evaluation,
    queryFn: async ({ signal }) => {
      try {
        return await api<EvalReport>('/lab/evaluation', { signal })
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null
        throw error
      }
    },
    staleTime: Infinity,
    retry: false,
  })
}
