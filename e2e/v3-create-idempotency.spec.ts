import assert from 'node:assert/strict';
import { test, expect } from 'playwright/test';
import { io as createClient } from 'socket.io-client';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { RoomCreationCatalog } from '../shared/roomContract';

type SocketAck = {
  ok: boolean;
  room: { code: string; id: string; roomRevision: number };
  credentials: { joinToken?: string };
};
type CatalogAck = { ok: boolean; catalog: RoomCreationCatalog };

let server: ChildProcess | undefined;
let dataDir = '';
let serverUrl = '';

const startServer = async (): Promise<void> => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'ww-v3-create-e2e-'));
  server = spawn(process.execPath, ['--import', 'tsx/esm', 'e2e/support/v3TestServer.ts'], {
    cwd: process.cwd(), env: { ...process.env, WW_E2E_DATA_DIR: dataDir, WW_E2E_PORT: '0', WW_ENV: 'test', WW_TEST_DROP_CREATE_ACK_ONCE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverUrl = await new Promise<string>((resolve, reject) => {
    let output = '';
    server?.stdout?.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/\[e2e:v3\] listening (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) resolve(match[1]);
    });
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
};

test.beforeEach(startServer);
test.afterEach(stopServer);

test('a committed create whose ACK is dropped is recovered to one room', async ({ page }) => {
  await page.addInitScript((url) => localStorage.setItem('wolf-server-url', url), serverUrl);
  await page.goto('/rooms/new/players');
  await expect(page.getByRole('heading', { name: '先决定今晚有多少人' })).toBeVisible({ timeout: 20_000 });

  const socket = createClient(serverUrl, { transports: ['polling'], reconnection: false, timeout: 5_000 });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const catalog = await new Promise<CatalogAck>((resolve) => socket.emit('v3:command', {
    meta: { commandId: 'catalog', actorId: 'catalog-reader', sentAt: Date.now() },
    command: { type: 'catalog.get', payload: {} },
  }, resolve));
  const preset = catalog.catalog.rolePresets.find((item: { enabled: boolean }) => item.enabled);
  const options = {
    ...preset,
    catalogVersion: catalog.catalog.catalogVersion,
    roomName: 'browser idempotent',
    creator: { name: 'Browser host', avatarId: 'avatar-player' },
    mode: 'human', visibility: 'invite_only', maxPlayers: preset.playerCount,
    minHumanPlayers: preset.playerCount, computerSeats: 0, aiFillPolicy: 'none',
    roleSetup: preset.roleSetup, rolePresetId: preset.id, rulesetId: preset.rulesetId,
    rulesetVersion: preset.rulesetVersion, readyPolicy: 'all_connected_humans',
    allowPublicSpectators: false, reviewEnabled: true,
  };
  socket.emit('v3:command', {
    meta: { commandId: 'browser-create-1', actorId: 'browser-host', sentAt: Date.now() },
    actorName: 'Browser host',
    command: { type: 'room.create', payload: { createRequestId: 'browser-create', options } },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  socket.disconnect();

  const retry = createClient(serverUrl, { transports: ['polling'], reconnection: false, timeout: 5_000 });
  try {
    await new Promise<void>((resolve, reject) => {
      retry.once('connect', resolve);
      retry.once('connect_error', reject);
    });
    const access = await new Promise<SocketAck>((resolve) => retry.emit('v3:command', {
      meta: { commandId: 'browser-create-2', actorId: 'browser-host', sentAt: Date.now() },
      actorName: 'Browser host',
      command: { type: 'room.create', payload: { createRequestId: 'browser-create', options } },
    }, resolve));
    assert.equal(access.ok, true);
  } finally {
    retry.disconnect();
  }
});
