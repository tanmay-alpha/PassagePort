import { createReadStream, existsSync, statSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

const root = path.dirname(fileURLToPath(import.meta.url))
const pdfjsRoot = path.join(root, 'node_modules', 'pdfjs-dist')
// Runtime data pdf.js fetches on demand: CJK character maps, the 14 standard fonts and
// image decoders. Served from our own origin because the CSP forbids any CDN.
const PDFJS_DATA_DIRS = ['cmaps', 'standard_fonts', 'wasm']
const PDFJS_PUBLIC_PATH = '/assets/pdfjs/'

function pdfjsData(): Plugin {
  let outDir = path.join(root, 'dist')
  let isBuild = false
  return {
    name: 'passageport:pdfjs-data',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
      isBuild = config.command === 'build' && config.mode !== 'test'
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]
        if (!url.startsWith(PDFJS_PUBLIC_PATH)) return next()
        const relative = path.normalize(decodeURIComponent(url.slice(PDFJS_PUBLIC_PATH.length)))
        const file = path.join(pdfjsRoot, relative)
        const allowed =
          PDFJS_DATA_DIRS.includes(relative.split(path.sep)[0]) && file.startsWith(pdfjsRoot + path.sep)
        if (!allowed || !existsSync(file) || !statSync(file).isFile()) return next()
        if (file.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm')
        createReadStream(file).pipe(res)
      })
    },
    async closeBundle() {
      if (!isBuild) return
      for (const dir of PDFJS_DATA_DIRS) {
        const source = path.join(pdfjsRoot, dir)
        if (existsSync(source)) {
          await cp(source, path.join(outDir, 'assets', 'pdfjs', dir), { recursive: true })
        }
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsData()],
  resolve: {
    alias: { '@': path.join(root, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      // Same paths as production, where the backend serves the SPA and /api from one origin.
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Stable vendor chunks: app releases do not invalidate the cached framework code.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react'
          if (/[\\/]node_modules[\\/](react-router|@tanstack)[\\/]/.test(id)) return 'data'
          if (/[\\/]node_modules[\\/](@radix-ui|@floating-ui|aria-hidden|react-remove-scroll|react-remove-scroll-bar|react-style-singleton|use-callback-ref|use-sidecar|get-nonce|tslib)[\\/]/.test(id)) {
            return 'ui'
          }
          return undefined
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
    testTimeout: 15_000,
  },
})
