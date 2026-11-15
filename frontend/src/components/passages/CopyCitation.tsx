import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { Passage } from '@/api/types'
import { IconButton } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { copyPlainText, formatCitation } from '@/lib/citation'

const CONFIRM_MS = 1600

/** Copies `Title, p. N — “excerpt”` as plain text. */
export function CopyCitationButton({ passage }: { passage: Passage }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const toast = useToast()
  useEffect(() => () => window.clearTimeout(timer.current), [])

  function copy() {
    copyPlainText(formatCitation(passage)).then(
      () => {
        setCopied(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), CONFIRM_MS)
      },
      (error: unknown) =>
        toast({ tone: 'danger', title: 'Could not copy the citation', description: error instanceof Error ? error.message : undefined }),
    )
  }

  return (
    <IconButton
      size="sm"
      label={copied ? 'Citation copied' : `Copy citation for ${passage.document_title}, ${passage.page_label}`}
      icon={copied ? <Check size={14} className="text-success" aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      onClick={copy}
      className="-my-1 shrink-0"
    />
  )
}
