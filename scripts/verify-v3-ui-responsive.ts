import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import { InMemoryEventStore } from '../server/events/store';
import { InMemoryRoomRepository } from '../server/rooms/repository';
import { RoomService } from '../server/rooms/roomService';
import { bindSocketTransport } from '../server/transport/socketTransport';

const workspace = process.cwd();
const screenshotDir = path.join(workspace, 'artifacts', 'w2-responsive');
const viewports = [
  { name: '390', width: 390, height: 844 },
  { name: '768', width: 768, height: 1024 },
  { name: '1440', width: 1440, height: 1000 },
] as const;

await mkdir(screenshotDir, { recursive: true });

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
const layoutMetricsScript = `(() => {
  const controls = [...document.querySelectorAll(
    'button, a, input, select, textarea'
  )].filter((element) => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.display !== 'none' && style.visibility !== 'hidden';
  });
  const clipped = controls
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
    viewportWidth: window.innerWidth,
    clipped,
    overlaps
  };
})()`;

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
  await page.goto(appUrl, { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: /创建普通房/ }).click();
  const createDialog = page.getByRole('dialog', {
    name: '创建普通房',
  });
  await createDialog.getByLabel('显示名称').fill('W2 Host');
  await createDialog
    .getByLabel('房间名称')
    .fill('W2 Responsive Room');
  await createDialog
    .getByRole('button', { name: '创建并进入' })
    .click();
  await page.waitForURL(/\/room\/[A-Z2-9]{6}$/, {
    timeout: 10_000,
  });
  assert.match(page.url(), /\/room\/[A-Z2-9]{6}$/);
  await page.getByRole('heading', { name: '等待房间' }).waitFor();
  const roomCode = page.url().split('/').at(-1)!;
  await page.getByRole('button', { name: '开始对局' }).click();
  await page.getByRole('heading', { name: '行动面板' }).waitFor({
    timeout: 10_000,
  });

  const gameSession = rooms.session(roomCode);
  assert.ok(gameSession);
  const guardian = gameSession.players.find(
    (player) => player.role === 'guardian',
  );
  const seer = gameSession.players.find(
    (player) => player.role === 'seer',
  );
  assert.ok(guardian);
  assert.ok(seer);
  await gameSession.dispatch(
    {
      commandId: 'responsive-guardian',
      actorId: guardian.id,
      sentAt: Date.now(),
      roomId: gameSession.serialize().state.roomId,
      gameId: gameSession.gameId,
      expectedStageRevision: gameSession.stageRevision,
    },
    {
      type: 'game.skip_night',
      payload: { action: 'guard' },
    },
  );
  await gameSession.dispatch(
    {
      commandId: 'responsive-seer',
      actorId: seer.id,
      sentAt: Date.now(),
      roomId: gameSession.serialize().state.roomId,
      gameId: gameSession.gameId,
      expectedStageRevision: gameSession.stageRevision,
    },
    {
      type: 'game.skip_night',
      payload: { action: 'check' },
    },
  );
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: '狼聊' }).waitFor({
    timeout: 10_000,
  });
  await page.getByRole('tab', { name: '狼人投票' }).click();
  const targetButtons = page.locator('.v3-target-grid button');
  await targetButtons.first().waitFor();
  assert.equal(await targetButtons.count(), 13);
  assert.equal(
    await targetButtons.filter({ hasText: '空刀' }).count(),
    1,
  );

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(200);
    const metrics = await page.evaluate(layoutMetricsScript) as {
      documentWidth: number;
      bodyWidth: number;
      viewportWidth: number;
      clipped: unknown[];
      overlaps: unknown[];
    };

    assert.ok(
      metrics.documentWidth <= viewport.width + 1,
      `${viewport.name}px document overflow: ${JSON.stringify(metrics)}`,
    );
    assert.ok(
      metrics.bodyWidth <= viewport.width + 1,
      `${viewport.name}px body overflow: ${JSON.stringify(metrics)}`,
    );
    assert.deepEqual(
      metrics.clipped,
      [],
      `${viewport.name}px clipped controls`,
    );
    assert.deepEqual(
      metrics.overlaps,
      [],
      `${viewport.name}px overlapping controls`,
    );
    await page.screenshot({
      path: path.join(screenshotDir, `game-${viewport.name}.png`),
      fullPage: true,
    });
  }

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
    `W2 responsive verification passed at ${viewports.map(({ name }) => name).join('/')} px.`,
  );
  console.log(`Screenshots: ${screenshotDir}`);
} finally {
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
