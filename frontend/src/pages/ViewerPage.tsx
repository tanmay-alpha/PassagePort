import { ArrowLeft } from 'lucide-react'
import { Link, useParams } from 'react-router'

import { useChunk, useDocument } from '@/api/queries'
import { Notice, Spinner } from '@/components/ui/Feedback'
import { DocumentViewer } from '@/components/viewer/DocumentViewer'
import { useDocumentTitle } from '@/lib/hooks'
import { useUrlParams } from '@/lib/params'
import { sectionPath } from '@/lib/workspace'

/** Full-page viewer. `?page=` selects the page, `?chunk=` the cited passage to highlight. */
export function Component() {
  const { documentId = '' } = useParams()
  const [params, patch] = useUrlParams()
  const chunkId = params.get('chunk')
  const chunk = useChunk(chunkId)
  const document = useDocument(documentId)
  useDocumentTitle(document.data?.title ?? 'Document')

  const pageParam = Number.parseInt(params.get('page') ?? '', 10)
  // Without an explicit page, a citation opens on the page it points at.
  const page = Number.isFinite(pageParam) ? pageParam : (chunk.data?.page_number ?? 1)
  const resolvingCitation = chunkId !== null && chunk.isPending && !Number.isFinite(pageParam)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {document.data ? (
        <div className="shrink-0 border-b border-line px-4 py-1.5">
          <Link
            to={sectionPath(document.data.collection_id, 'library')}
            className="inline-flex items-center gap-1.5 rounded-sm text-[13px] font-medium text-ink-2 hover:text-ink"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Library
          </Link>
        </div>
      ) : null}
      {chunkId !== null && chunk.isError ? (
        <Notice tone="warning" className="m-3 shrink-0" title="The cited passage no longer exists.">
          The document may have been re-indexed since this link was created. Nothing is highlighted.
        </Notice>
      ) : null}
      <div className="min-h-0 flex-1">
        {resolvingCitation ? (
          <div className="p-4 text-ink-2">
            <Spinner label="Locating the cited passage…" />
          </div>
        ) : (
          <DocumentViewer
            documentId={documentId}
            page={page}
            highlight={chunk.data ?? null}
            onPageChange={(next) => patch({ page: String(next) }, { replace: true })}
          />
        )}
      </div>
    </div>
  )
}
