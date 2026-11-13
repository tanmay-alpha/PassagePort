import { useEffect } from 'react'
import { useParams } from 'react-router'

import { useCollections, useDocument } from '@/api/queries'
import type { CollectionOut } from '@/api/types'

import { readStored, writeStored } from './hooks'

const LAST_COLLECTION_KEY = 'pp.lastCollection'

/** DOM id of the Search screen's query box; the global shortcut focuses it. */
export const SEARCH_INPUT_ID = 'search-query'

export const SECTIONS = ['library', 'search', 'ask', 'compare', 'lab'] as const
export type Section = (typeof SECTIONS)[number]

export function sectionPath(collectionId: string, section: Section): string {
  const base = `/c/${encodeURIComponent(collectionId)}`
  return section === 'library' ? base : `${base}/${section}`
}

export interface ViewerTarget {
  documentId: string
  page?: number
  chunkId?: string
}

export function viewerPath({ documentId, page, chunkId }: ViewerTarget): string {
  const params = new URLSearchParams()
  if (page !== undefined) params.set('page', String(page))
  if (chunkId) params.set('chunk', chunkId)
  const query = params.toString()
  return `/d/${encodeURIComponent(documentId)}${query ? `?${query}` : ''}`
}

export interface ActiveWorkspace {
  collections: CollectionOut[] | undefined
  /** The workspace navigation applies to: the one in the URL, else the last one used. */
  active: CollectionOut | null
  isPending: boolean
}

/**
 * Resolves which workspace the sidebar and global shortcuts act on. Screens outside a
 * workspace (home, settings) fall back to the last one visited so navigation stays one click.
 */
export function useActiveWorkspace(): ActiveWorkspace {
  const { collectionId, documentId } = useParams()
  const collections = useCollections()
  const viewedDocument = useDocument(documentId)
  const routeId = collectionId ?? viewedDocument.data?.collection_id

  useEffect(() => {
    if (routeId) writeStored(LAST_COLLECTION_KEY, routeId)
  }, [routeId])

  const list = collections.data
  const wantedId = routeId ?? readStored(LAST_COLLECTION_KEY)
  const active = list?.find((collection) => collection.id === wantedId) ?? (routeId ? null : (list?.[0] ?? null))
  return { collections: list, active, isPending: collections.isPending }
}

/** The workspace named by the current route, or why it is unavailable. */
export function useRouteCollection(): {
  collectionId: string
  collection: CollectionOut | undefined
  isPending: boolean
  isMissing: boolean
  error: unknown
} {
  const { collectionId = '' } = useParams()
  const collections = useCollections()
  const collection = collections.data?.find((item) => item.id === collectionId)
  return {
    collectionId,
    collection,
    isPending: collections.isPending,
    isMissing: collections.isSuccess && !collection,
    error: collections.error,
  }
}
