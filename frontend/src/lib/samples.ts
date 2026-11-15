import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'

import { invalidateLibrary, useCollections, useCreateCollection, useSystem } from '@/api/queries'
import type { CollectionOut, DocumentOut } from '@/api/types'

import { enqueueUploads } from './uploads'
import { sectionPath } from './workspace'

/**
 * The original sample files, shipped as static assets of this app (`public/samples/`) and
 * uploaded through the normal upload API, so the demo exercises the real pipeline.
 */
export const SAMPLE_FILES = [
  { name: 'os-notes-deadlocks.pdf', type: 'application/pdf', description: 'Lecture notes on deadlocks' },
  { name: 'harbor-api-spec-v1.pdf', type: 'application/pdf', description: 'API specification, version 1' },
  { name: 'harbor-api-spec-v2.pdf', type: 'application/pdf', description: 'API specification, version 2' },
  { name: 'networking-notes.md', type: 'text/markdown', description: 'TCP networking notes' },
] as const

export type SampleName = (typeof SAMPLE_FILES)[number]['name']

export const SAMPLE_WORKSPACE = {
  name: 'Sample library',
  description: 'Operating-system lecture notes, two versions of an API specification and TCP networking notes.',
}

/** Workspace names are unique: "Sample library", then "Sample library 2", … */
export function sampleWorkspaceName(existing: readonly Pick<CollectionOut, 'name'>[]): string {
  const taken = new Set(existing.map((collection) => collection.name.trim().toLowerCase()))
  let name = SAMPLE_WORKSPACE.name
  for (let suffix = 2; taken.has(name.toLowerCase()); suffix += 1) name = `${SAMPLE_WORKSPACE.name} ${suffix}`
  return name
}

/** Same-origin path of a bundled sample; the CSP allows nothing else. */
export function sampleUrl(name: SampleName): string {
  return `/samples/${encodeURIComponent(name)}`
}

/** Downloads every sample from this origin. Rejects if any of them is unavailable. */
export async function fetchSampleFiles(signal?: AbortSignal): Promise<File[]> {
  return Promise.all(
    SAMPLE_FILES.map(async ({ name, type }) => {
      const response = await fetch(sampleUrl(name), { credentials: 'same-origin', signal })
      if (!response.ok) throw new Error(`The sample file ${name} could not be downloaded (${response.status}).`)
      return new File([await response.blob()], name, { type })
    }),
  )
}

export type SampleLoadPhase = 'idle' | 'fetching' | 'creating'

/**
 * One click: fetch the bundled samples, create a workspace, queue the four uploads (their byte
 * progress shows in the library) and open that workspace.
 */
export function useLoadSamples() {
  const system = useSystem()
  const collections = useCollections()
  const create = useCreateCollection()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [phase, setPhase] = useState<SampleLoadPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const limits = system.data?.limits

  /** Resolves to the error message, or null once the workspace is open. */
  async function start(): Promise<string | null> {
    if (phase !== 'idle') return null
    if (!limits) return 'The server limits are still loading. Try again in a moment.'
    setError(null)
    try {
      setPhase('fetching')
      const files = await fetchSampleFiles()
      setPhase('creating')
      const name = sampleWorkspaceName(collections.data ?? [])
      const collection = await create.mutateAsync({ ...SAMPLE_WORKSPACE, name })
      enqueueUploads(collection.id, files, limits, () => invalidateLibrary(queryClient, collection.id))
      void navigate(sectionPath(collection.id, 'library'))
      return null
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The samples could not be loaded.'
      setError(message)
      return message
    } finally {
      setPhase('idle')
    }
  }

  return { start, phase, error, ready: limits !== undefined }
}

export type SuggestionKind = 'search' | 'ask' | 'compare' | 'lab'

export interface SampleSuggestion {
  kind: SuggestionKind
  label: string
  query: string
  /** Sample files that must be indexed before the suggestion can run. */
  needs: SampleName[]
}

export const SAMPLE_SUGGESTIONS: SampleSuggestion[] = [
  { kind: 'search', label: 'deadlock prevention', query: 'deadlock prevention', needs: ['os-notes-deadlocks.pdf'] },
  { kind: 'ask', label: 'What does ECONNRESET mean?', query: 'What does ECONNRESET mean?', needs: ['networking-notes.md'] },
  {
    kind: 'compare',
    label: 'API v1 vs v2 on rate limits',
    query: 'rate limiting requests per minute',
    needs: ['harbor-api-spec-v1.pdf', 'harbor-api-spec-v2.pdf'],
  },
  { kind: 'lab', label: 'circular wait', query: 'circular wait', needs: ['os-notes-deadlocks.pdf'] },
]

/** The workspace's documents that are bundled samples, by file name. */
export function sampleDocuments(documents: readonly DocumentOut[]): Map<SampleName, DocumentOut> {
  const found = new Map<SampleName, DocumentOut>()
  for (const sample of SAMPLE_FILES) {
    const document = documents.find((candidate) => candidate.filename === sample.name)
    if (document) found.set(sample.name, document)
  }
  return found
}

/** Where a suggestion leads, with the documents it compares; null until they are indexed. */
export function suggestionPath(
  collectionId: string,
  suggestion: SampleSuggestion,
  samples: Map<SampleName, DocumentOut>,
): string | null {
  const needed = suggestion.needs.map((name) => samples.get(name))
  if (needed.some((document) => document?.status !== 'indexed')) return null
  const params = new URLSearchParams({ q: suggestion.query })
  if (suggestion.kind === 'compare') params.set('docs', needed.map((document) => document?.id ?? '').join(','))
  return `${sectionPath(collectionId, suggestion.kind)}?${params.toString()}`
}
