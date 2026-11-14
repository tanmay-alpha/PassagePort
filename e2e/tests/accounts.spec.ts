import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { BackendServer, BASE_URL, createDataDir } from '../server.mjs';

const dataDir = createDataDir();
const server = new BackendServer(dataDir, {
  PP_AUTH_MODE: 'accounts', PP_COOKIE_SECURE: 'false', PP_ALLOW_SIGNUP: 'true', PP_ALLOW_GUESTS: 'false',
});
const csrf = { 'X-PassagePort-CSRF': '1' };

test.beforeAll(async () => { await server.start(); });
test.afterAll(async () => {
  await server.stop();
  if (!process.env.E2E_DATA_DIR) rmSync(dataDir, { recursive: true, force: true });
});

test('real signup, confidential upload, cross-account denial and logout', async ({ page, playwright }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole('tab', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to PassagePort' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Name your first workspace' }).fill('Private research');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page).toHaveURL(/\/c\/[^/]+$/);
  const id = new URL(page.url()).pathname.split('/')[2];
  await page.getByTestId('file-input').setInputFiles({
    name: 'confidential.txt', mimeType: 'text/plain',
    buffer: Buffer.from('The confidential recovery phrase is mountain-ferry. Access is restricted to this account.'),
  });
  await expect.poll(async () => {
    const response = await page.request.get(`/api/collections/${id}/documents`);
    return (await response.json()).find((d: { status: string }) => d.status === 'indexed')?.id;
  }, { timeout: 45_000 }).toBeTruthy();
  const [doc] = await (await page.request.get(`/api/collections/${id}/documents`)).json();
  const other = await playwright.request.newContext({ baseURL: BASE_URL });
  const signup = await other.post('/api/auth/signup', {
    headers: csrf, data: { username: 'bob', password: 'another-correct-test-password' },
  });
  expect(signup.ok()).toBeTruthy();
  expect(await (await other.get('/api/collections')).json()).toEqual([]);
  for (const path of [
    `/api/collections/${id}`, `/api/collections/${id}/documents`, `/api/documents/${doc.id}`,
    `/api/documents/${doc.id}/file`, `/api/documents/${doc.id}/pages/1`, `/api/documents/${doc.id}/outline`,
  ]) {
    expect((await other.get(path)).status(), `foreign resource ${path}`).toBe(404);
  }
  expect((await other.post('/api/search', { headers: csrf, data: { collection_id: id, query: 'recovery phrase' } })).status()).toBe(404);
  const noCsrf = await page.request.delete(`/api/documents/${doc.id}`);
  expect(noCsrf.status()).toBe(403);
  expect((await page.request.get(`/api/documents/${doc.id}/file`)).ok()).toBeTruthy();

  const logout = await page.request.post('/api/auth/logout', { headers: csrf });
  expect(logout.status()).toBe(204);
  expect((await page.request.get(`/api/documents/${doc.id}/file`)).status()).toBe(401);
  await page.reload();
  await expect(page).toHaveURL(/\/login/);
  await other.dispose();
});
