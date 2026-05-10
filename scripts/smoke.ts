/**
 * Smoke test: boot the Express app without touching the database
 * and assert health endpoints respond. Exits 0 on success, 1 on failure.
 *
 * Used at bootstrap time when no Postgres is available locally — the
 * normal `server.ts` is the production entrypoint and *does* require DB.
 */
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';

interface JsonResult {
  status: number;
  body: unknown;
}

async function fetchJson(url: string): Promise<JsonResult> {
  const res = await fetch(url);
  const body = (await res.json()) as unknown;
  return { status: res.status, body };
}

async function main(): Promise<void> {
  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind port');
  const port = address.port;
  const base = `http://127.0.0.1:${port}`;

  const root = await fetchJson(`${base}/`);
  console.log(`GET /                 -> ${root.status}`);
  console.log(`  body: ${JSON.stringify(root.body)}`);

  const live = await fetchJson(`${base}${env.API_PREFIX}/health`);
  console.log(`GET ${env.API_PREFIX}/health   -> ${live.status}`);
  console.log(`  body: ${JSON.stringify(live.body)}`);

  const missing = await fetchJson(`${base}${env.API_PREFIX}/does-not-exist`);
  console.log(`GET ${env.API_PREFIX}/does-not-exist -> ${missing.status}`);
  console.log(`  body: ${JSON.stringify(missing.body)}`);

  server.close();

  const ok =
    root.status === 200 &&
    live.status === 200 &&
    missing.status === 404 &&
    isSuccess(root.body) &&
    isSuccess(live.body) &&
    isError(missing.body);

  if (!ok) {
    console.error('\n✘ smoke test FAILED');
    process.exit(1);
  }
  console.log('\n✔ smoke test passed');
  process.exit(0);
}

function isSuccess(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { success?: unknown }).success === true;
}

function isError(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { success?: unknown }).success === false;
}

main().catch((err: unknown) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
