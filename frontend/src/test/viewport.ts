type Viewport = 'desktop' | 'mobile'

/**
 * jsdom has no layout, so `matchMedia` is stubbed: width queries follow the chosen viewport,
 * everything else (dark scheme, reduced motion) is false.
 */
export function setViewport(viewport: Viewport): void {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: viewport === 'desktop' && query.includes('min-width'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
}
