import { Minus, Plus } from 'lucide-react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask, TextLayer } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useEffect, useRef, useState } from 'react'

import { documentFileUrl } from '@/api/client'
import { Button, IconButton } from '@/components/ui/Button'
import { Notice, Spinner } from '@/components/ui/Feedback'
import { matchPassage } from '@/lib/passageMatch'

// The worker and pdf.js' data files are bundled and served from our origin (strict CSP, no CDN).
GlobalWorkerOptions.workerSrc = workerUrl
const PDFJS_DATA = '/assets/pdfjs'

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const
/** Room for the page outline inside the scroll area's content box. */
const PAGE_GUTTER = 2
/** Keeps canvases within what mobile browsers allocate reliably. */
const MAX_CANVAS_PIXELS = 16_000_000

type LoadState = { status: 'loading' } | { status: 'ready'; pdf: PDFDocumentProxy } | { status: 'error' }
type HighlightState = 'none' | 'found' | 'missing'

export interface PdfPaneProps {
  documentId: string
  page: number
  /** Text of the cited passage on this page, if any. */
  highlightText: string | null
  onShowText: () => void
  onPageCount: (count: number) => void
}

/** Wraps the matched part of each text-layer run; returns the first highlighted element. */
function applyHighlight(divs: HTMLElement[], strings: string[], passage: string): HTMLElement | null {
  const ranges = matchPassage(strings, passage)
  if (!ranges) return null
  let first: HTMLElement | null = null
  for (const range of ranges) {
    const div = divs[range.item]
    const value = strings[range.item]
    if (!div || value === undefined) continue
    const hit = document.createElement('span')
    hit.className = 'pp-pdf-hit'
    hit.textContent = value.slice(range.start, range.end)
    div.replaceChildren(value.slice(0, range.start), hit, value.slice(range.end))
    first ??= hit
  }
  return first
}

export default function PdfPane({ documentId, page, highlightText, onShowText, onPageCount }: PdfPaneProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [width, setWidth] = useState(0)
  const [zoomIndex, setZoomIndex] = useState<number>(ZOOM_STEPS.indexOf(1))
  const [rendered, setRendered] = useState<{ key: string; highlight: HighlightState; failed: boolean } | null>(null)
  const reportPageCount = useRef(onPageCount)
  useEffect(() => {
    reportPageCount.current = onPageCount
  })

  useEffect(() => {
    let cancelled = false
    const task = getDocument({
      url: documentFileUrl(documentId),
      cMapUrl: `${PDFJS_DATA}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS_DATA}/standard_fonts/`,
      wasmUrl: `${PDFJS_DATA}/wasm/`,
      // pdf.js 6 converts CMYK images through an ICC profile it fetches from here.
      iccUrl: `${PDFJS_DATA}/iccs/`,
    })
    task.promise.then(
      (pdf) => {
        if (cancelled) return
        setLoad({ status: 'ready', pdf })
        reportPageCount.current(pdf.numPages)
      },
      () => {
        if (!cancelled) setLoad({ status: 'error' })
      },
    )
    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [documentId])

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0)
      setWidth((current) => (Math.abs(current - next) > 1 ? next : current))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const pdf = load.status === 'ready' ? load.pdf : null
  const zoom = ZOOM_STEPS[zoomIndex]
  const renderKey = `${page}:${width}:${zoom}:${highlightText ?? ''}`

  useEffect(() => {
    const target = host.current
    if (!pdf || !target || width <= 0 || page < 1 || page > pdf.numPages) return
    let cancelled = false
    let renderTask: RenderTask | null = null
    let textLayer: TextLayer | null = null

    async function render(pdfDocument: PDFDocumentProxy, container: HTMLDivElement) {
      const pdfPage = await pdfDocument.getPage(page)
      if (cancelled) return
      const base = pdfPage.getViewport({ scale: 1 })
      const scale = (Math.max(width - PAGE_GUTTER, 160) / base.width) * zoom
      const viewport = pdfPage.getViewport({ scale })
      const density = Math.min(
        window.devicePixelRatio || 1,
        Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)),
      )
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width * density)
      canvas.height = Math.floor(viewport.height * density)
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`
      canvas.setAttribute('role', 'img')
      canvas.setAttribute('aria-label', `Page ${page} of the original document`)

      renderTask = pdfPage.render({
        canvas,
        viewport,
        transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0],
      })
      await renderTask.promise
      if (cancelled) return

      const layer = document.createElement('div')
      layer.className = 'textLayer'
      container.style.width = `${Math.floor(viewport.width)}px`
      container.style.height = `${Math.floor(viewport.height)}px`
      container.style.setProperty('--total-scale-factor', String(scale))
      container.replaceChildren(canvas, layer)

      textLayer = new TextLayer({ textContentSource: pdfPage.streamTextContent(), container: layer, viewport })
      await textLayer.render()
      if (cancelled) return

      let highlight: HighlightState = 'none'
      if (highlightText) {
        const first = applyHighlight(textLayer.textDivs, textLayer.textContentItemsStr, highlightText)
        highlight = first ? 'found' : 'missing'
        first?.scrollIntoView({ block: 'center', inline: 'nearest' })
      } else {
        scroller.current?.scrollTo({ top: 0 })
      }
      setRendered({ key: renderKey, highlight, failed: false })
    }

    render(pdf, target).catch((error: unknown) => {
      const cancelledRender = error instanceof Error && error.name === 'RenderingCancelledException'
      if (!cancelled && !cancelledRender) setRendered({ key: renderKey, highlight: 'none', failed: true })
    })

    return () => {
      cancelled = true
      renderTask?.cancel()
      textLayer?.cancel()
    }
  }, [pdf, page, width, zoom, highlightText, renderKey])

  if (load.status === 'error') {
    return (
      <div className="p-4">
        <Notice
          tone="danger"
          title="The original file could not be displayed."
          action={
            <Button size="sm" onClick={onShowText}>
              Show extracted text
            </Button>
          }
        >
          It may be damaged or use a PDF feature this viewer does not support.
        </Notice>
      </div>
    )
  }

  const current = rendered?.key === renderKey ? rendered : null
  const outOfRange = pdf !== null && (page < 1 || page > pdf.numPages)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-10 flex-wrap items-center gap-2 border-b border-line px-3 py-1">
        <div className="flex items-center gap-0.5" role="group" aria-label="Zoom">
          <IconButton
            size="sm"
            label="Zoom out"
            icon={<Minus size={14} aria-hidden="true" />}
            disabled={zoomIndex === 0}
            onClick={() => setZoomIndex((index) => Math.max(index - 1, 0))}
          />
          <span className="w-12 text-center text-xs text-ink-2 tabular-nums" aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <IconButton
            size="sm"
            label="Zoom in"
            icon={<Plus size={14} aria-hidden="true" />}
            disabled={zoomIndex === ZOOM_STEPS.length - 1}
            onClick={() => setZoomIndex((index) => Math.min(index + 1, ZOOM_STEPS.length - 1))}
          />
        </div>
        <div className="min-w-0 flex-1 text-right text-[13px] text-ink-2" aria-live="polite">
          {!current && !outOfRange ? <Spinner size={12} label="Rendering page…" /> : null}
          {current?.highlight === 'found' ? 'Cited passage highlighted' : null}
        </div>
      </div>
      {current?.highlight === 'missing' ? (
        <Notice
          tone="warning"
          className="m-3"
          title="The cited passage could not be located in the original layout."
          action={
            <Button size="sm" onClick={onShowText}>
              Show in Text
            </Button>
          }
        >
          Nothing is highlighted here. The Text tab shows the exact passage.
        </Notice>
      ) : null}
      {current?.failed ? (
        <Notice tone="danger" className="m-3" title="This page could not be rendered." />
      ) : null}
      {outOfRange ? (
        <Notice tone="warning" className="m-3" title="The original file has no page with this number." />
      ) : null}
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto bg-subtle p-4 [scrollbar-gutter:stable]">
        <div ref={host} className="pp-pdf-page" />
      </div>
    </div>
  )
}
