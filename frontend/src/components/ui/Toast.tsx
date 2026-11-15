import { CircleAlert, CircleCheck, X } from 'lucide-react'
import { createContext, type ReactNode, use, useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type ToastTone = 'success' | 'danger'

export interface ToastInput {
  title: string
  description?: string
  tone?: ToastTone
}

interface ToastItem extends ToastInput {
  id: number
}

type ShowToast = (toast: ToastInput) => void

const ToastContext = createContext<ShowToast | null>(null)

const AUTO_DISMISS_MS = 5000

/** Returns a function that shows a short, non-blocking status message. */
export function useToast(): ShowToast {
  const show = use(ToastContext)
  if (!show) throw new Error('useToast must be used inside <ToastProvider>')
  return show
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)
  const timers = useRef(new Map<number, number>())

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const show = useCallback<ShowToast>(
    (toast) => {
      const id = nextId.current++
      setToasts((current) => [...current.slice(-2), { ...toast, id }])
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS),
      )
    },
    [dismiss],
  )

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer)
    }
  }, [])

  const region = useMemo(
    () => (
      // The region is always mounted so screen readers announce toasts added later.
      <div
        role="region"
        aria-label="Notifications"
        className="pointer-events-none fixed right-4 bottom-4 z-[80] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
      >
        <div aria-live="polite" aria-atomic="false" className="flex flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              role={toast.tone === 'danger' ? 'alert' : undefined}
              className="pointer-events-auto flex animate-pop-in items-start gap-2.5 rounded-lg border border-line bg-surface p-3 shadow-pop"
            >
              {toast.tone === 'danger' ? (
                <CircleAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
              ) : (
                <CircleCheck size={16} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">{toast.title}</p>
                {toast.description ? <p className="mt-0.5 text-[13px] text-ink-2">{toast.description}</p> : null}
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => dismiss(toast.id)}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-subtle hover:text-ink"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      </div>
    ),
    [toasts, dismiss],
  )

  return (
    <ToastContext value={show}>
      {children}
      {region}
    </ToastContext>
  )
}
