import { useSyncExternalStore } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

/** Keep the key and colours in sync with public/theme-init.js, which runs before first paint. */
export const THEME_STORAGE_KEY = 'pp.theme'
const THEME_COLORS: Record<ResolvedTheme, string> = { light: '#FAFAF7', dark: '#121413' }
const DARK_QUERY = '(prefers-color-scheme: dark)'

const listeners = new Set<() => void>()

function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // Storage blocked: behave as "system".
  }
  return 'system'
}

function systemTheme(): ResolvedTheme {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference
}

function apply(preference: ThemePreference): void {
  const resolved = resolveTheme(preference)
  document.documentElement.dataset.theme = resolved
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[resolved])
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY)
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // Storage blocked: the choice still applies for this page view.
  }
  apply(preference)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onSystemChange = () => {
    apply(readPreference())
    listener()
  }
  const media = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null
  media?.addEventListener('change', onSystemChange)
  window.addEventListener('storage', onSystemChange)
  return () => {
    listeners.delete(listener)
    media?.removeEventListener('change', onSystemChange)
    window.removeEventListener('storage', onSystemChange)
  }
}

function snapshot(): string {
  const preference = readPreference()
  return `${preference}:${resolveTheme(preference)}`
}

export function useTheme(): { preference: ThemePreference; resolved: ResolvedTheme } {
  const [preference, resolved] = useSyncExternalStore(subscribe, snapshot, () => 'system:light').split(':')
  return { preference: preference as ThemePreference, resolved: resolved as ResolvedTheme }
}

/** Idempotent; also covers the case where theme-init.js could not run. */
export function initTheme(): void {
  apply(readPreference())
}
