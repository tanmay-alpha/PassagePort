import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { BackendServer, BASE_URL, createDataDir } from '../server.mjs';

const dataDir = createDataDir();
const server = new BackendServer(dataDir);
const samples = resolve(import.meta.dirname, '../../samples');
const csrf = { 'X-PassagePort-CSRF': '1' };

test.beforeAll(async () => { await server.start(); });
test.afterAll(async () => {
  await server.stop();
  if (!process.env.E2E_DATA_DIR) rmSync(dataDir, { recursive: true, force: true });
});

test('create → upload PDFs → index → search → cited page → compare → restart → recover', async ({ page, request }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to PassagePort' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Name your first workspace' }).fill('Interview workspace');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page).toHaveURL(/\/c\/[^/]+$/);
  const collectionId = new URL(page.url()).pathname.split('/')[2];

  await page.getByTestId('file-input').setInputFiles([
    resolve(samples, 'os-notes-deadlocks.pdf'),
    resolve(samples, 'harbor-api-spec-v1.pdf'),
    resolve(samples, 'harbor-api-spec-v2.pdf'),
    resolve(samples, 'networking-notes.md'),
  ]);
  // The browser uploads and the real leased worker parses and indexes the files. Poll the API
  // only to observe completion; no direct writes or mocks replace any pipeline stage.
  await expect.poll(async () => {
    const res = await request.get(`/api/collections/${collectionId}/documents`);
    const docs = await res.json();
    return docs.filter((d: { status: string }) => d.status === 'indexed').length;
  }, { timeout: 75_000 }).toBe(4);
  await expect(page.getByRole('link', { name: 'os-notes-deadlocks', exact: true }).first()).toBeVisible();

  // A duplicate is a visible, non-destructive upload outcome.
  await page.getByTestId('file-input').setInputFiles(resolve(samples, 'os-notes-deadlocks.pdf'));
  await expect(page.getByTestId('upload-row').last()).toContainText(/already|duplicate/i);
  const docs = await (await request.get(`/api/collections/${collectionId}/documents`)).json();
  expect(docs).toHaveLength(4);

  await page.goto(`/c/${collectionId}/search`);
  const searchInput = page.getByRole('searchbox', { name: 'Search Interview workspace' });
  await searchInput.fill('deadlock prevention');
  const searchResponse = page.waitForResponse(r => r.url().endsWith('/api/search') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const found = await (await searchResponse).json();
  expect(found.results.length).toBeGreaterThan(0);
  const hit = found.results.find((h: { page_number: number; document_title: string }) =>
    h.document_title === 'os-notes-deadlocks' && h.page_number === 2);
  await expect(page.getByRole('heading', { name: 'Search', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  expect(hit, 'the deadlock prevention passage must cite PDF page 2').toBeDefined();
  await page.locator(`button[data-passage="${hit.chunk_id}"]`).click();
  await expect(page.getByRole('textbox', { name: /^Page of \d+$/ })).toHaveValue('2');
  await expect(page.getByRole('img', { name: 'Page 2 of the original document', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await expect(page.locator('mark').filter({ hasText: /prevention/i }).last()).toBeVisible();
  const sourcePage = await (await request.get(`/api/documents/${hit.document_id}/pages/2`)).json();
  expect(Array.from(sourcePage.text).slice(hit.char_start, hit.char_end).join('')).toBe(hit.text);
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();

  await page.goto(`/c/${collectionId}/ask`);
  await page.getByRole('textbox', { name: 'Your question' }).fill('deadlock prevention');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByText('Excerpts from your documents', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Citation 1: show the cited passage' }).first().click();
  await expect(page.getByRole('textbox', { name: /^Page of \d+$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();

  const versions = docs.filter((d: { title: string }) => /^harbor-api-spec-v[12]$/.test(d.title));
  await page.goto(`/c/${collectionId}/compare`);
  await page.getByRole('button', { name: /Choose documents/ }).click();
  for (const doc of versions) {
    await page.getByRole('menuitemcheckbox', { name: doc.title, exact: true }).click();
  }
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: 'What to compare' }).fill('rate limiting requests per minute');
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  const numbers = page.getByRole('table', { name: 'Numbers that differ' }).first();
  await expect(numbers).toBeVisible();
  await expect(numbers).toContainText('100');
  await expect(numbers).toContainText('250');
  await expect(page.getByText('Model interpretation', { exact: true })).toHaveCount(0);

  await page.goto(`/c/${collectionId}/lab`);
  await page.getByRole('textbox', { name: 'Query to inspect' }).fill('ECONNRESET');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Rankings by stage' })).toBeVisible();
  // Small screens use accessible stage tabs rather than four cramped columns.
  if (await page.getByRole('tab', { name: 'Keyword', exact: true }).isVisible()) {
    await page.getByRole('tab', { name: 'Keyword', exact: true }).click();
  }
  await expect(page.getByTestId('stage-keyword')).toContainText('ECONNRESET');

  // New backend process, same persistent store. A citation saved before restart still resolves.
  await server.stop();
  await server.start();
  const afterRestart = await request.get(`/api/collections/${collectionId}/documents`);
  expect(afterRestart.ok()).toBeTruthy();
  expect((await afterRestart.json()).map((d: { id: string }) => d.id).sort()).toEqual(docs.map((d: { id: string }) => d.id).sort());
  const cited = await request.get(`/api/chunks/${hit.chunk_id}`);
  expect(cited.ok()).toBeTruthy();
  expect((await cited.json()).text).toBe(hit.text);
  await page.goto(`/d/${hit.document_id}?page=2&chunk=${hit.chunk_id}`);
  await expect(page.getByRole('textbox', { name: /^Page of \d+$/ })).toHaveValue('2');
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await expect(page.locator('mark').filter({ hasText: /prevention/i })).toBeVisible();
  expect(errors, 'no uncaught browser errors during the real workflow').toEqual([]);
});

test('invalid content is rejected visibly and the app remains usable', async ({ page, request }) => {
  const created = await request.post('/api/collections', { headers: csrf, data: { name: 'Invalid upload checks' } });
  expect(created.ok()).toBeTruthy();
  const collection = await created.json();
  await page.goto(`/c/${collection.id}`);
  await page.getByTestId('file-input').setInputFiles({ name: 'disguised.pdf', mimeType: 'application/pdf', buffer: Buffer.from('This is not a PDF') });
  await expect(page.getByTestId('upload-row')).toContainText(/PDF|file|format/i);
  await expect.poll(async () => (await (await request.get(`/api/collections/${collection.id}/documents`)).json()).length).toBe(0);
  expect((await request.get(`${BASE_URL}/api/health`)).ok()).toBeTruthy();
});
