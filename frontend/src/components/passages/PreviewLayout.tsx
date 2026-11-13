import { type ReactNode, useState } from 'react'

import type { Passage } from '@/api/types'
import { Sheet } from '@/components/ui/Dialog'
import { SplitPane } from '@/components/ui/SplitPane'
import { DocumentViewer } from '@/components/viewer/DocumentViewer'
import { DESKTOP_QUERY, useMediaQuery, useWindowKeydown } from '@/lib/hooks'

export interface PreviewLayoutProps {
  /** The screen's own content (results, answer, comparison). */
  children: ReactNode
  /** The passage to show in the viewer; null closes the preview. */
  passage: Passage | null
  onClose: () => void
  /** Accessible name of the content pane, e.g. "Search results". */
  label: string
}

function PreviewViewer({ passage, onClose }: { passage: Passage; onClose: () => void }) {
  // Page navigation inside the preview is local; the citation itself stays in the URL.
  const [page, setPage] = useState(passage.page_number)
  return (
    <DocumentViewer
      documentId={passage.document_id}
      page={page}
      onPageChange={setPage}
      highlight={passage}
      onClose={onClose}
    />
  )
}

/**
 * Content with an optional document preview: a resizable split on desktop, a full-screen
 * sheet on smaller screens. Escape closes the preview.
 */
export function PreviewLayout({ children, passage, onClose, label }: PreviewLayoutProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const viewer = passage ? <PreviewViewer key={passage.chunk_id} passage={passage} onClose={onClose} /> : null

  useWindowKeydown((event) => {
    // Radix layers (menus, dialogs, selects) mark Escape as handled before it gets here.
    if (event.key === 'Escape' && !event.defaultPrevented) onClose()
  }, desktop && passage !== null)

  return (
    <>
      <SplitPane
        primary={children}
        secondary={desktop ? viewer : null}
        primaryLabel={label}
        secondaryLabel="Document preview"
        storageKey="pp.previewSplit"
        defaultRatio={0.48}
        minRatio={0.3}
        maxRatio={0.7}
      />
      {desktop ? null : (
        <Sheet open={passage !== null} onOpenChange={(open) => !open && onClose()} title="Document preview" side="full">
          {viewer}
        </Sheet>
      )}
    </>
  )
}
