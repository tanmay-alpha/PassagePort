# PassagePort web client

React 19, TypeScript and Vite frontend for the PassagePort document workspace. The UI uses
Radix primitives, Tailwind semantic theme tokens, React Router and TanStack Query. API wire
types in `src/api/types.ts` mirror `backend/passageport/api/schemas.py`.

## Development

Use Node.js 20.19 or newer and npm:

```bash
npm ci
npm run dev
```

Vite serves the app on port 5173 and proxies `/api` unchanged to `http://127.0.0.1:8000`.
Start the FastAPI backend separately. API calls are same-origin, use cookie sessions and
send the CSRF header on mutations; no frontend environment variables or secrets are needed.

## Checks and production

```bash
npm run typecheck
npm run lint
npx vitest --run
npm run build
```

The production SPA is emitted to `dist/`. Set the backend's `PP_STATIC_DIR` to the absolute
path of `frontend/dist` to serve it alongside the API, independent of the server's working
directory. The original PDF viewer and pdf.js are loaded lazily; the worker, fonts, character
maps and decoders are served locally. Local authentication mode has no sign-in or API tokens;
account sign-in, guest access and token controls follow the backend's advertised capabilities.

## Source layout

- `src/api/`: typed API client, shared queries, mutations and indexing polling.
- `src/pages/`: onboarding, library, search, ask, compare, Search Lab, viewer, login and settings.
- `src/components/`: accessible controls, navigation, document filters, passages and viewer.
- `src/lib/`: URL state, uploads, theme persistence, text offsets and PDF passage matching.
- `src/test/`: MSW handlers, contract-shaped fixtures, route renderer and viewport helper.

Indexing completion is detected in shared queries so cached retrieval results refresh even
after leaving the library. Text citations use authoritative page code-point offsets. PDF
highlights require a unique normalized full-passage match: ambiguous or inexact matches
show a visible fallback to the exact extracted Text view rather than a misleading highlight.
Controlled dialogs and sheets trap focus and return it to their opener when closed.

Tests exercise real routes and providers with MSW at the API boundary, including indexing
transitions, exact Unicode citation offsets, authentication failures and successful safe
redirects, guest access, token creation/copy/revocation, persisted themes, keyboard shortcuts
and mobile navigation. The multipart test harness retains browser form construction
for React while using Node-compatible multipart bodies for intercepted uploads.
