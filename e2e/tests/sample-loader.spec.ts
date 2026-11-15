import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { BackendServer, createDataDir } from '../server.mjs';

// Its own empty data directory: the welcome screen (and its sample loader) only shows when no
// workspace exists yet.
const dataDir = createDataDir();
const server = new BackendServer(dataDir);

test.beforeAll(async () => { await server.start(); });
test.afterAll(async () => {
  await server.stop();
  if (!process.env.E2E_DATA_DIR) rmSync(dataDir, { recursive: true, force: true });
});

test('welcome → load sample documents → all four indexed → a suggested query runs', async ({ page, request }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to PassagePort' })).toBeVisible();
  // The bundled samples are fetched from this origin and uploaded through the normal upload API.
  await page.getByRole('button', { name: 'Load sample documents', exact: true }).click();
  await expect(page).toHaveURL(/\/c\/[^/]+$/);
  await expect(page.getByRole('heading', { name: 'Sample library', level: 1 })).toBeVisible();
  const collectionId = new URL(page.url()).pathname.split('/')[2];

  // The real worker parses and indexes them; the API is only polled to observe completion.
  await expect.poll(async () => {
    const docs = await (await request.get(`/api/collections/${collectionId}/documents`)).json();
    return docs.filter((d: { status: string }) => d.status === 'indexed').map((d: { filename: string }) => d.filename).sort();
  }, { timeout: 75_000 }).toEqual(['harbor-api-spec-v1.pdf', 'harbor-api-spec-v2.pdf', 'networking-notes.md', 'os-notes-deadlocks.pdf']);
  // The library shows the same state without a reload.
  await expect(page.getByText('Indexed', { exact: true })).toHaveCount(4);

  const searchResponse = page.waitForResponse((r) => r.url().endsWith('/api/search') && r.request().method() === 'POST');
  await page.getByRole('link', { name: 'Search deadlock prevention' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${collectionId}/search\\?q=deadlock\\+prevention`));
  const found = await (await searchResponse).json();
  const hit = found.results.find((h: { document_title: string; page_number: number }) =>
    h.document_title === 'os-notes-deadlocks' && h.page_number === 2);
  expect(hit, 'the suggested query must find the deadlock prevention page').toBeDefined();
  await expect(page.locator(`button[data-passage="${hit.chunk_id}"]`)).toContainText('Deadlock prevention');
  expect(errors, 'no uncaught browser errors while loading the samples').toEqual([]);
});
