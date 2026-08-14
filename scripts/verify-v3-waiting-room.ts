import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { Server } from 'socket.io';
import { io as createClient, type Socket } from 'socket.io-client';
import { createServer as createViteServer } from 'vite';
import type { JoinRoomAck, V3Command } from '../shared/protocol';
import { InMemoryEventStore } from '../server/events/store';
import { InMemoryRoomRepository } from '../server/rooms/repository';
import { RoomService } from '../server/rooms/roomService';
import { bindSocketTransport } from '../server/transport/socketTransport';

const workspace = process.cwd();
const screenshotDir = path.join(
  workspace,
  'artifacts',
  'w3-p2-waiting-room',
);
const viewports = [
  { name: '390', width: 390, height: 844 },
  { name: '768', width: 768, height: 1024 },
  { name: '1440', width: 1440, height: 1000 },
] as const;

await mkdir(screenshotDir, { recursive: true });

const layoutMetricsScript = `(() => {
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.display !== 'none' && style.visibility !== 'hidden';
  };
  const controls = [...document.querySelectorAll(
    'button, a, input, select, textarea'
  )].filter(visible);
  const memberRows = [...document.querySelectorAll(
    '.v3-summary-list > div'
  )].filter(visible);
  const clipped = [...controls, ...memberRows]
    .filter((element) =>
      element.scrollWidth > element.clientWidth + 1 ||
      element.scrollHeight > element.clientHeight + 1
    )
    .map((element) => ({
      text: (
        element.textContent ||
        element.getAttribute('aria-label') ||
        element.tagName
      ).trim().slice(0, 80),
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight
    }));
  const overlaps = [];
  for (let firstIndex = 0; firstIndex < controls.length; firstIndex += 1) {
    const first = controls[firstIndex];
    const firstRect = first.getBoundingClientRect();
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < controls.length;
      secondIndex += 1
    ) {
      const second = controls[secondIndex];
      if (first.contains(second) || second.contains(first)) continue;
      const secondRect = second.getBoundingClientRect();
      const overlapWidth =
        Math.min(firstRect.right, secondRect.right) -
        Math.max(firstRect.left, secondRect.left);
      const overlapHeight =
        Math.min(firstRect.bottom, secondRect.bottom) -
        Math.max(firstRect.top, secondRect.top);
      if (overlapWidth > 2 && overlapHeight > 2) {
        overlaps.push({
          first: (
            first.textContent ||
            first.getAttribute('aria-label') ||
            first.tagName
          ).trim().slice(0, 40),
          second: (
            second.textContent ||
            second.getAttribute('aria-label') ||
            second.tagName
          ).trim().slice(0, 40)
        });
      }
    }
  }
  return {
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    clipped,
    overlaps
  };
})()`;

const captureLayout = async (
  page: Page,
  state: 'joined' | 'offline',
): Promise<void> => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    const metrics = await page.evaluate(layoutMetricsScript) as {
      documentWidth: number;
      bodyWidth: number;
      clipped: unknown[];
      overlaps: unknown[];
    };
    await page.screenshot({
      path: path.join(
        screenshotDir,
        `${state}-${viewport.name}.png`,
      ),
      fullPage: true,
    });
    assert.ok(
      metrics.documentWidth <= viewport.width + 1,
      `${state} ${viewport.name}px document overflow: ${JSON.stringify(metrics)}`,
    );
    assert.ok(
      metrics.bodyWidth <= viewport.width + 1,
      `${state} ${viewport.name}px body overflow: ${JSON.stringify(metrics)}`,
    );
    assert.deepEqual(
      metrics.clipped,
      [],
      `${state} ${viewport.name}px clipped content`,
    );
    assert.deepEqual(
      metrics.overlaps,
      [],
      `${state} ${viewport.name}px overlapping controls`,
    );
  }
};

const socketHttpServer = createHttpServer();
const io = new Server(socketHttpServer, {
  cors: { origin: true, credentials: true },
});
const rooms = new RoomService(
  new InMemoryRoomRepository(),
  new InMemoryEventStore(),
  { autoDrive: false },
);
bindSocketTransport(io, rooms);
await new Promise<void>((resolve) => {
  socketHttpServer.listen(0, '127.0.0.1', resolve);
});
const socketAddress = socketHttpServer.address();
assert.ok(socketAddress && typeof socketAddress === 'object');
const serverUrl = `http://127.0.0.1:${socketAddress.port}`;

const vite = await createViteServer({
  root: workspace,
  logLevel: 'silent',
  server: {
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
  },
});
await vite.listen();
const viteAddress = vite.httpServer?.address();
assert.ok(viteAddress && typeof viteAddress === 'object');
const appUrl = `http://127.0.0.1:${viteAddress.port}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
});
const page = await context.newPage();
const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const requestFailures: Array<{ url: string; error: string }> = [];
let guest: Socket | null = null;

page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('requestfailed', (request) => {
  requestFailures.push({
    url: request.url(),
    error: request.failure()?.errorText ?? 'failed',
  });
});

try {
  await page.addInitScript((url) => {
    localStorage.setItem('wolf-server-url', url);
  }, serverUrl);
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });

  await page.goto(`${appUrl}/rooms/new/players`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('显示名称').fill('W3-P2 Host');
  await page.getByLabel('房间名称').fill('W3-P2 Waiting Room');
  await page.getByRole('button', { name: '继续选择角色' }).click();
  await page.getByRole('button', { name: '继续选择规则' }).click();
  await page.getByRole('button', { name: '查看确认' }).click();
  await page.getByRole('button', { name: '创建并进入等待房' }).click();
  await page.waitForURL(/\/rooms\/[A-Z2-9]{6}\/waiting$/, {
    timeout: 10_000,
  });
  await page.getByRole('heading', { name: '玩家席' }).waitFor();
  await page.locator('.waiting-room__meta-item').first().getByText(/1\s*\/\s*12/).waitFor();

  const access = await page.evaluate(async () => {
    const module = await import('/src/stores/v3Store.ts');
    const state = module.useV3Store.getState();
    return {
      roomCode: state.room?.code ?? '',
      joinToken: state.session?.credentials.joinToken ?? '',
    };
  });
  assert.match(access.roomCode, /^[A-Z2-9]{6}$/);
  assert.ok(access.joinToken);

  guest = createClient(serverUrl, {
    transports: ['websocket'],
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    guest?.once('connect', resolve);
    guest?.once('connect_error', reject);
  });
  const joinCommand: V3Command & { actorName: string } = {
    meta: {
      commandId: crypto.randomUUID(),
      actorId: 'w3-p2-guest',
      sentAt: Date.now(),
    },
    actorName: 'W3-P2 Guest',
    command: {
      type: 'room.join',
      payload: {
        roomCode: access.roomCode,
        joinToken: access.joinToken,
      },
    },
  };
  const joined = await new Promise<JoinRoomAck>((resolve) => {
    guest?.emit('v3:command', joinCommand, resolve);
  });
  assert.equal(joined.ok, true);

  await page.locator('.waiting-room__meta-item').first().getByText(/2\s*\/\s*12/).waitFor({
    timeout: 5_000,
  });
  const memberSeats = page.locator('.ww-seat--player');
  assert.equal(await memberSeats.count(), 2);
  assert.equal(
    await page.getByText('离线 · 未准备').count(),
    0,
  );
  await captureLayout(page, 'joined');

  guest.disconnect();
  await page.getByText('离线 · 未准备').waitFor({
    timeout: 5_000,
  });
  assert.equal(await memberSeats.count(), 2);
  assert.equal(
    await page.getByText('离线 · 未准备').count(),
    1,
  );
  await captureLayout(page, 'offline');

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(
    requestFailures.filter(
      ({ url }) =>
        !url.includes('fonts.googleapis.com') &&
        !url.includes('fonts.gstatic.com'),
    ),
    [],
  );
  console.log(
    `W3-P2 waiting-room verification passed at ${viewports.map(({ name }) => name).join('/')} px.`,
  );
  console.log('Member count updated 1 -> 2; disconnect rendered offline.');
  console.log(`Screenshots: ${screenshotDir}`);
} finally {
  guest?.disconnect();
  await context.close();
  await browser.close();
  await rooms.close();
  await vite.close();
  await new Promise<void>((resolve, reject) => {
    io.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
