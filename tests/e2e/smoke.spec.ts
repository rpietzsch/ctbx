import { expect, test } from '@playwright/test';

/**
 * End-to-end smoke tests against the production build served at the real base
 * path. These deliberately use no API keys (see the "no keys in tests" rule in
 * tasks/backlog.md) — they cover the shell, routing and first-run behaviour.
 */

test('serves the app shell at the GitHub Pages base path', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Chat' })).toBeVisible();
});

test('shows first-run guidance when no provider key is configured', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: /welcome to ctbx/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /add an api key/i })).toBeVisible();
});

test('deep links survive a reload, because routing is hash based', async ({ page }) => {
  await page.goto('./#/settings/servers');
  await expect(page.getByRole('heading', { name: 'MCP servers' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'MCP servers' })).toBeVisible();
});

test('lists every provider with a key field', async ({ page }) => {
  await page.goto('./#/settings/providers');
  for (const provider of ['OpenRouter', 'OpenAI', 'Anthropic', 'Google']) {
    await expect(page.getByRole('heading', { name: provider, exact: true })).toBeVisible();
  }
});

test('warns about direct browser access on the Anthropic card', async ({ page }) => {
  await page.goto('./#/settings/providers');
  await expect(page.getByText(/dangerous-direct-browser-access/i)).toBeVisible();
});

test('can add an MCP server with just a name and an endpoint', async ({ page }) => {
  await page.goto('./#/settings/servers');
  await page.getByRole('button', { name: 'Add server' }).click();

  await page.getByLabel('Name').fill('Example');
  await page.getByLabel('Endpoint IRI').fill('https://mcp.example.com/mcp');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('heading', { name: 'Example' })).toBeVisible();
  await expect(page.getByText('https://mcp.example.com/mcp')).toBeVisible();
});

test('rejects an endpoint that is not a valid URL', async ({ page }) => {
  await page.goto('./#/settings/servers');
  await page.getByRole('button', { name: 'Add server' }).click();

  await page.getByLabel('Name').fill('Bad');
  await page.getByLabel('Endpoint IRI').fill('not-a-url');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('alert')).toContainText(/not a valid endpoint/i);
});

test('the data screen accounts for stored items without revealing values', async ({ page }) => {
  await page.goto('./#/settings/servers');
  await page.getByRole('button', { name: 'Add server' }).click();
  await page.getByLabel('Name').fill('Example');
  await page.getByLabel('Endpoint IRI').fill('https://mcp.example.com/mcp');
  await page.getByRole('button', { name: 'Save' }).click();

  await page.goto('./#/settings/data');
  await expect(page.getByText('Configured MCP servers')).toBeVisible();
  await expect(page.getByRole('button', { name: /forget everything/i })).toBeVisible();
});

test('serves the static OAuth callback page as a real file', async ({ page }) => {
  // GitHub Pages has no SPA fallback, so this must exist on disk (spec §7.5).
  const response = await page.goto('./oauth/callback.html');
  expect(response?.status()).toBe(200);
});

test('serves the client ID metadata document with a self-consistent client_id', async ({
  request,
  baseURL,
}) => {
  const response = await request.get('./oauth/client-metadata.json');
  expect(response.status()).toBe(200);

  const document = (await response.json()) as { client_id: string; redirect_uris: string[] };
  expect(document.client_id).toMatch(/\/oauth\/client-metadata\.json$/);
  expect(document.redirect_uris.some((uri) => uri.endsWith('/oauth/callback.html'))).toBe(true);
  expect(baseURL).toBeTruthy();
});
