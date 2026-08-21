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
const allocatePort = async (): Promise<number> => {
  const probe = createHttpServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
  return port;
};
const screenshotDir = path.join(
  workspace,
  'artifacts',
  'monitor-responsive',
);
const viewports = [
  { name: '375x812', width: 375, height: 812, screenshot: true },
  { name: '390x844', width: 390, height: 844, screenshot: true },
  { name: '412x915', width: 412, height: 915, screenshot: true },
  { name: '768x1024', width: 768, height: 1024, screenshot: true },
  { name: '1024x768', width: 1024, height: 768, screenshot: true },
  { name: '1199x800', width: 1199, height: 800, screenshot: true },
  { name: '1280x900', width: 1280, height: 900, screenshot: true },
  { name: '1440x900', width: 1440, height: 900, screenshot: true },
  { name: '1920x1080', width: 1920, height: 1080, screenshot: true },
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
    port: await allocatePort(),
    strictPort: false,
    watch: null,
  },
});
await vite.listen();
const viteAddress = vite.httpServer?.address();
assert.ok(viteAddress && typeof viteAddress === 'object');
const appUrl = `http://127.0.0.1:${viteAddress.port}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 768, height: 1024 },
});
const page = await context.newPage();
const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const requestFailures: Array<{ url: string; error: string }> = [];
const layoutMetricsScript = `(() => {
  const isVisibleInClipChain = (element) => {
    const elementRect = element.getBoundingClientRect();
    let left = elementRect.left;
    let right = elementRect.right;
    let top = elementRect.top;
    let bottom = elementRect.bottom;
    let ancestor = element.parentElement;
    while (ancestor) {
      const style = getComputedStyle(ancestor);
      const clipsX = ['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowX);
      const clipsY = ['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowY);
      if (clipsX || clipsY) {
        const ancestorRect = ancestor.getBoundingClientRect();
        if (clipsX) {
          left = Math.max(left, ancestorRect.left);
          right = Math.min(right, ancestorRect.right);
        }
        if (clipsY) {
          top = Math.max(top, ancestorRect.top);
          bottom = Math.min(bottom, ancestorRect.bottom);
        }
        if (right <= left || bottom <= top) return false;
      }
      ancestor = ancestor.parentElement;
    }
    return right - left > 2 && bottom - top > 2;
  };
  const controls = [...document.querySelectorAll(
    'button, a, input, select, textarea'
  )].filter((element) => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.display !== 'none' && style.visibility !== 'hidden' &&
      isVisibleInClipChain(element);
  });
  const clippedControls = controls
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
  const overlappingControls = [];
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
        overlappingControls.push({
          first: (
            first.textContent ||
            first.getAttribute('aria-label') ||
            first.tagName
          ).trim().slice(0, 40),
          second: (
            second.textContent ||
            second.getAttribute('aria-label') ||
            second.tagName
          ).trim().slice(0, 40),
          firstRect: {
            left: firstRect.left,
            right: firstRect.right,
            top: firstRect.top,
            bottom: firstRect.bottom,
          },
          secondRect: {
            left: secondRect.left,
            right: secondRect.right,
            top: secondRect.top,
            bottom: secondRect.bottom,
          },
          firstParent: first.parentElement?.className ?? '',
          secondParent: second.parentElement?.className ?? ''
        });
      }
    }
  }
  const identityNames = [
    ...document.querySelectorAll('.v3-identity-list > div > strong')
  ].map((element) => {
    const row = element.parentElement;
    const rect = element.getBoundingClientRect();
    const rowRect = row?.getBoundingClientRect();
    const style = getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight);
    return {
      text: element.textContent?.trim() || '',
      width: rect.width,
      height: rect.height,
      lineHeight,
      singleLine: rect.height <= lineHeight + 1,
      clipped:
        element.scrollWidth > element.clientWidth + 1 ||
        element.scrollHeight > element.clientHeight + 1,
      insideRow: rowRect
        ? rect.left >= rowRect.left - 1 &&
          rect.right <= rowRect.right + 1 &&
          rect.top >= rowRect.top - 1 &&
          rect.bottom <= rowRect.bottom + 1
        : false
    };
  });
  const identityRows = [
    ...document.querySelectorAll('.v3-identity-list > div')
  ].map((row) => {
    const rowRect = row.getBoundingClientRect();
    const children = [...row.children].map((child) => {
      const rect = child.getBoundingClientRect();
      return {
        text: child.textContent?.trim() || '',
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom
      };
    });
    const childOverflow = children.some((child) =>
      child.left < rowRect.left - 1 ||
      child.right > rowRect.right + 1 ||
      child.top < rowRect.top - 1 ||
      child.bottom > rowRect.bottom + 1
    );
    const childOverlap = children.some((first, firstIndex) =>
      children.slice(firstIndex + 1).some((second) =>
        Math.min(first.right, second.right) -
          Math.max(first.left, second.left) > 1 &&
        Math.min(first.bottom, second.bottom) -
          Math.max(first.top, second.top) > 1
      )
    );
    return {
      text: row.textContent?.trim() || '',
      width: rowRect.width,
      height: rowRect.height,
      childOverflow,
      childOverlap
    };
  });
  return {
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
    overflowElements: [...document.querySelectorAll('*')]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          className: typeof element.className === 'string' ? element.className : '',
          text: (element.textContent ?? '').trim().slice(0, 80),
          left: rect.left,
          right: rect.right,
          width: rect.width,
        };
      })
      .filter(({ left, right }) => left < -1 || right > window.innerWidth + 1)
      .slice(-20),
    clippedControls,
    overlappingControls,
    identityNames,
    identityRows
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
  await page.goto(appUrl, { waitUntil: 'commit', timeout: 30_000 });
  await page.getByRole('button', { name: '创建房间', exact: true }).waitFor({ timeout: 90_000 });
  const roomCode = await page.evaluate(async () => {
    const loadStore = new Function('return import("/src/stores/v3Store.ts")');
    const module = await loadStore();
    const store = module.useV3Store;
    await store.getState().refreshCatalog();
    const catalog = store.getState().catalog;
    const preset = catalog?.rolePresets.find((candidate: { enabled: boolean }) => candidate.enabled);
    if (!catalog || !preset) throw new Error('No enabled room preset');
    const response = await store.getState().createRoomWithOptions({
      catalogVersion: catalog.catalogVersion,
      roomName: 'Monitor Responsive Room',
      creator: { name: 'Monitor Host', avatarId: 'avatar-player' },
      mode: 'quick_computer',
      visibility: 'invite_only',
      maxPlayers: preset.playerCount,
      minHumanPlayers: 0,
      computerSeats: 0,
      aiFillPolicy: 'fill_to_max',
      roleSetup: { ...preset.roleSetup },
      rolePresetId: preset.id,
      rulesetId: preset.rulesetId,
      rulesetVersion: preset.rulesetVersion,
      readyPolicy: 'all_connected_humans',
      allowPublicSpectators: false,
      reviewEnabled: true,
    });
    if (!response.ok) throw new Error('Quick computer room creation failed');
    return response.room.code;
  });
  await page.goto(`${appUrl}/rooms/${roomCode}`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/rooms\/[A-Z2-9]{6}\/monitor$/, {
    timeout: 15_000,
  });
  await page.getByRole('heading', { name: '身份摘要' }).waitFor({
    timeout: 15_000,
  });

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(200);
    const metrics = await page.evaluate(layoutMetricsScript) as {
      documentWidth: number;
      bodyWidth: number;
      viewportWidth: number;
      overflowElements: unknown[];
      clippedControls: unknown[];
      overlappingControls: unknown[];
      identityNames: Array<{
        text: string;
        width: number;
        height: number;
        lineHeight: number;
        singleLine: boolean;
        clipped: boolean;
        insideRow: boolean;
      }>;
      identityRows: Array<{
        text: string;
        width: number;
        height: number;
        childOverflow: boolean;
        childOverlap: boolean;
      }>;
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
      metrics.clippedControls,
      [],
      `${viewport.name}px clipped controls`,
    );
    assert.deepEqual(
      metrics.overlappingControls,
      [],
      `${viewport.name}px overlapping controls`,
    );
    assert.equal(
      metrics.identityNames.length,
      12,
      `${viewport.name}px identity count`,
    );
    assert.deepEqual(
      metrics.identityNames.filter(({ singleLine }) => !singleLine),
      [],
      `${viewport.name}px wrapped identity names`,
    );
    assert.deepEqual(
      metrics.identityNames.filter(({ clipped }) => clipped),
      [],
      `${viewport.name}px clipped identity names`,
    );
    assert.deepEqual(
      metrics.identityNames.filter(({ insideRow }) => !insideRow),
      [],
      `${viewport.name}px identity names outside rows`,
    );
    assert.deepEqual(
      metrics.identityRows.filter(
        ({ childOverflow, childOverlap }) =>
          childOverflow || childOverlap,
      ),
      [],
      `${viewport.name}px identity row overflow or overlap`,
    );
    if (viewport.screenshot) {
      await page.screenshot({
        path: path.join(screenshotDir, `monitor-${viewport.name}.png`),
        fullPage: true,
      });
    }
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
    `Monitor responsive verification passed at ${viewports.map(({ name }) => name).join('/')} px.`,
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
