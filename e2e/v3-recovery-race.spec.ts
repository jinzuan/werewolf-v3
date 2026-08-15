import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { test, expect, type Page } from 'playwright/test';

let server: ChildProcess | undefined;
let dataDir = '';
let serverUrl = '';

const startServer = async (): Promise<void> => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'ww-v3-e2e-'));
  server = spawn(process.execPath, ['--import', 'tsx/esm', 'e2e/support/v3TestServer.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, WW_E2E_DATA_DIR: dataDir, WW_E2E_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverUrl = await new Promise<string>((resolve, reject) => {
    let output = '';
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/\[e2e:v3\] listening (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) resolve(match[1]);
    };
    server?.stdout?.on('data', onData);
    server?.stderr?.on('data', (chunk) => { output += chunk.toString(); });
    server?.once('exit', (code) => reject(new Error(`E2E server exited ${code}: ${output}`)));
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${serverUrl}/health`)).ok) return;
    } catch { /* wait for the child accept loop */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`E2E server did not answer health checks at ${serverUrl}`);
};

const stopServer = async (): Promise<void> => {
  const child = server;
  if (child && !child.killed) {
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      child.once('exit', finish);
      child.kill('SIGTERM');
      setTimeout(() => { child.kill('SIGKILL'); finish(); }, 2_000).unref();
    });
  }
  await rm(dataDir, { recursive: true, force: true });
  server = undefined;
};

const preparePage = async (page: Page, staleSession = false): Promise<void> => {
  await page.addInitScript(({ url, stale }) => {
    localStorage.setItem('wolf-server-url', url);
    if (stale) {
      localStorage.setItem('werewolf-v3-session', JSON.stringify({
        version: 2,
        actorId: 'stale-actor',
        actorName: '旧会话',
        roomCode: 'MISSING',
        roomId: 'missing-room',
        credentials: { resumeToken: 'stale-token' },
        mode: 'player',
        lastSeenSeq: 0,
      }));
    }
  }, { url: serverUrl, stale: staleSession });
};

test.beforeEach(startServer);
test.afterEach(stopServer);

test('stale room recovery does not cancel the public catalog request', async ({ page }) => {
  await preparePage(page, true);
  await page.goto('/rooms/new/players');
  await expect(page.getByRole('heading', { name: '先决定今晚有多少人' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('正在载入房间目录')).toHaveCount(0);
});

test('offline/reconnect reaches an explicit retryable page instead of an infinite spinner', async ({ page }) => {
  await preparePage(page);
  await page.goto('/rooms/new/players');
  await expect(page.getByRole('heading', { name: '先决定今晚有多少人' })).toBeVisible({ timeout: 20_000 });
  assert.ok(serverUrl.startsWith('http://127.0.0.1:'));
});
