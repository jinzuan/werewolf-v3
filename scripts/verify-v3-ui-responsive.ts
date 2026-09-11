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
const screenshotDir = path.join(workspace, 'artifacts', 'w2-responsive');
const viewports = [
  { name: '375x812', width: 375, height: 812 },
  { name: '390x844', width: 390, height: 844 },
  { name: '412x915', width: 412, height: 915 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '1199x800', width: 1199, height: 800 },
  { name: '1280x900', width: 1280, height: 900 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
] as const;

await mkdir(screenshotDir, { recursive: true });

const socketHttpServer = createHttpServer();
const io = new Server(socketHttpServer, {
  cors: { origin: true, credentials: true },
});
const rooms = new RoomService(
  new InMemoryRoomRepository(),
  new InMemoryEventStore(),
  { autoDrive: false, seatRandomIndex: () => 0, roleRandomIndex: () => 0 },
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
  viewport: { width: 390, height: 844 },
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
          ).trim().slice(0, 40),
          firstRect: { left: firstRect.left, right: firstRect.right, top: firstRect.top, bottom: firstRect.bottom },
          secondRect: { left: secondRect.left, right: secondRect.right, top: secondRect.top, bottom: secondRect.bottom },
          firstClass: first.className,
          secondClass: second.className
        });
      }
    }
  }
  return {
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
    clipped,
    overlaps,
    mobileNavTop: (() => {
      const nav = document.querySelector('.v3-mobile-match-nav');
      const rect = nav?.getBoundingClientRect();
      return rect && rect.width > 0 && rect.height > 0 ? rect.top : null;
    })(),
    actionButtonBottom: [...document.querySelectorAll('button')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && element.textContent?.includes('确认');
      })
      .at(-1)
      ?.getBoundingClientRect().bottom ?? null,
    scrollContainers: [...document.querySelectorAll('*')]
      .filter((element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return element.scrollHeight > element.clientHeight + 2 &&
          ['auto', 'scroll'].includes(style.overflowY) &&
          isVisibleInClipChain(element);
      })
      .map((element) => element.className || element.tagName)
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

const verifyPageMatrix = async (name: string): Promise<void> => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.v3-app-shell__body');
      if (scroller) scroller.scrollTop = 0;
    });
    await page.waitForTimeout(100);
    const metrics = await page.evaluate(layoutMetricsScript) as {
      documentWidth: number;
      bodyWidth: number;
      viewportWidth: number;
      clipped: unknown[];
      overlaps: unknown[];
      scrollContainers: string[];
    };
    assert.ok(metrics.documentWidth <= viewport.width + 1, `${name} ${viewport.name}px document overflow: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.bodyWidth <= viewport.width + 1, `${name} ${viewport.name}px body overflow: ${JSON.stringify(metrics)}`);
    assert.deepEqual(metrics.clipped, [], `${name} ${viewport.name}px clipped controls`);
    assert.deepEqual(metrics.overlaps, [], `${name} ${viewport.name}px overlapping controls`);
    assert.ok(metrics.scrollContainers.length <= 1, `${name} ${viewport.name}px has nested scroll areas: ${JSON.stringify(metrics.scrollContainers)}`);
    await page.screenshot({ path: path.join(screenshotDir, `${name}-${viewport.name}.png`) });
  }
};

const captureGameStage = async (
  name: string,
  viewport: { width: number; height: number },
): Promise<void> => {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(150);
  const metrics = await page.evaluate(`(() => {
    const rect = (selector) => {
      const bounds = document.querySelector(selector)?.getBoundingClientRect();
      return bounds ? {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      } : null;
    };
    const visible = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return false;
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    return {
      stage: rect('.v3-stage-summary'),
      workspace: rect('.v3-game-workspace'),
      left: rect('.v3-match-layout__left'),
      right: rect('.v3-match-layout__right'),
      statusVisible: visible('.v3-room-header__room-state'),
      connectionVisible: visible('.v3-room-header__connection'),
      syncVisible: visible('.v3-room-header__sync'),
      phaseVisible: visible('.v3-room-header__phase'),
      helpVisible: visible('.v3-room-header__actions button[title="帮助"]'),
      settingsVisible: visible('.v3-room-header__actions a[title="设置"]'),
      actions: rect('.v3-room-header__actions'),
      phaseText: document.querySelector('.v3-room-header__phase')?.textContent?.trim() ?? '',
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
    };
  })()`) as {
    stage: { left: number; right: number; width: number; height: number } | null;
    workspace: { left: number; right: number; width: number; height: number } | null;
    left: { width: number } | null;
    right: { width: number } | null;
    statusVisible: boolean;
    connectionVisible: boolean;
    syncVisible: boolean;
    phaseVisible: boolean;
    helpVisible: boolean;
    settingsVisible: boolean;
    actions: { left: number; right: number; width: number; height: number } | null;
    phaseText: string;
    overflow: number;
  };
  assert.ok(metrics.stage && metrics.workspace, `${name} lacks stage/workspace`);
  assert.ok(Math.abs(metrics.stage.left - metrics.workspace.left) <= 1, `${name} left edge mismatch`);
  assert.ok(Math.abs(metrics.stage.right - metrics.workspace.right) <= 1, `${name} right edge mismatch`);
  assert.equal(metrics.statusVisible, true, `${name} hides room status`);
  assert.equal(metrics.connectionVisible, true, `${name} hides connection state`);
  assert.equal(metrics.syncVisible, true, `${name} hides sync state`);
  assert.equal(metrics.phaseVisible, true, `${name} hides current phase`);
  assert.equal(metrics.helpVisible, true, `${name} hides help`);
  assert.equal(metrics.settingsVisible, true, `${name} hides settings`);
  assert.ok(metrics.actions && metrics.actions.right <= viewport.width + 1, `${name} clips right-side header controls`);
  assert.notEqual(metrics.phaseText, '', `${name} has an empty phase label`);
  assert.ok(metrics.overflow <= 1, `${name} overflows horizontally by ${metrics.overflow}px`);
  if (viewport.width >= 1280) {
    assert.ok(metrics.left && metrics.right, `${name} lacks desktop side rails`);
    assert.ok(
      Math.abs(metrics.left.width - metrics.right.width) <= 2,
      `${name} side rail widths differ: ${metrics.left.width}/${metrics.right.width}`,
    );
  }
  if (viewport.width < 768) {
    assert.ok(metrics.stage.height <= 86, `${name} mobile stage bar is too tall: ${metrics.stage.height}`);
  } else if (viewport.width < 1280) {
    assert.ok(metrics.stage.height <= 110, `${name} tablet stage bar is too tall: ${metrics.stage.height}`);
  }
  await page.screenshot({
    path: path.join(screenshotDir, `${name}-${viewport.width}x${viewport.height}.png`),
    fullPage: true,
  });
};

try {
  await page.addInitScript((url) => {
    localStorage.setItem('wolf-server-url', url);
  }, serverUrl);
  await page.goto(appUrl, { waitUntil: 'commit', timeout: 30_000 });
  await page.getByRole('button', { name: '创建房间', exact: true }).waitFor({ timeout: 90_000 });
  await verifyPageMatrix('lobby');
  await page.goto(`${appUrl}/rooms/join`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '用房间码找到同伴' }).waitFor();
  await verifyPageMatrix('join');
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });

  const createRoomButton = page.getByRole('button', { name: '创建房间', exact: true });
  await createRoomButton.waitFor({ timeout: 90_000 });
  await createRoomButton.click();
  await page.waitForURL(/\/rooms\/[A-Z2-9]{6}\/waiting$/, {
    timeout: 10_000,
  });
  assert.match(page.url(), /\/rooms\/[A-Z2-9]{6}\/waiting$/);
  await page.getByRole('heading', { name: '安排玩家席位' }).waitFor();
  await verifyPageMatrix('waiting');
  const roomCode = page.url().split('/').at(-2)!;
  const beginReadyButton = page.getByRole('button', { name: '开始准备' });
  if (await beginReadyButton.isVisible()) await beginReadyButton.click();
  const startGameButton = page.getByRole('button', { name: '开始游戏' });
  if (!await startGameButton.isEnabled()) {
    await page.getByRole('button', { name: '确认准备' }).click();
  }
  await startGameButton.click();
  await page.getByRole('heading', { name: '行动面板' }).waitFor({
    timeout: 10_000,
  });

  await captureGameStage('role-confirmation', { width: 1440, height: 900 });

  const gameSession = rooms.session(roomCode);
  assert.ok(gameSession);
  if (gameSession.serialize().state.gameState.phase === 'role_confirm') {
    for (const player of gameSession.players.filter((candidate) => !candidate.isAI)) {
      if (gameSession.serialize().state.roleConfirmations[player.id] === true) continue;
      const result = await gameSession.dispatch(
        {
          commandId: `responsive-confirm-${player.id}`,
          actorId: player.id,
          sentAt: Date.now(),
          roomId: gameSession.serialize().state.roomId,
          gameId: gameSession.gameId,
          expectedStageRevision: gameSession.stageRevision,
        },
        { type: 'game.confirm_role', payload: {} },
      );
      assert.equal(result.ok, true);
    }
  }
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
  assert.equal(gameSession.serialize().state.gameState.nightStage, 'wolf_discussion');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText(/狼人讨论/).first().waitFor({ timeout: 10_000 });
  await captureGameStage('wolf-discussion', { width: 1440, height: 900 });
  const wolves = gameSession.players.filter(
    (player) => player.isAlive && player.role === 'wolf',
  );
  for (let round = 1; round <= 2; round += 1) {
    for (const wolf of wolves) {
      await gameSession.dispatch(
        {
          commandId: `responsive-wolf-${round}-${wolf.id}`,
          actorId: wolf.id,
          sentAt: Date.now(),
          roomId: gameSession.serialize().state.roomId,
          gameId: gameSession.gameId,
          expectedStageRevision: gameSession.stageRevision,
        },
        {
          type: 'game.wolf_speak',
          payload: { content: `第${round}轮确认目标与理由。` },
        },
      );
    }
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: '狼人投票' }).waitFor({
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
    if (viewport.width < 768) {
      await page.getByRole('button', { name: /确认/ }).last().scrollIntoViewIfNeeded();
    }
    await page.waitForTimeout(200);
    const metrics = await page.evaluate(layoutMetricsScript) as {
      documentWidth: number;
      bodyWidth: number;
      viewportWidth: number;
      clipped: unknown[];
      overlaps: unknown[];
      mobileNavTop: number | null;
      actionButtonBottom: number | null;
      scrollContainers: string[];
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
    assert.ok(
      metrics.scrollContainers.every((className) => [
        'v3-chat-list',
        'v3-player-grid',
        'v3-match-side v3-desktop-info-rail',
        'v3-mobile-pane-action',
        'v3-event-list v3-event-list--desktop',
        'v3-event-list v3-event-list--mobile',
        'v3-game-workspace',
      ].some((allowed) => className.includes(allowed))),
      `${viewport.name}px has an unexpected scroll area: ${JSON.stringify(metrics.scrollContainers)}`,
    );
    assert.ok(
      metrics.scrollContainers.length <= (viewport.width < 768 ? 1 : 3),
      `${viewport.name}px has too many competing scroll areas: ${JSON.stringify(metrics.scrollContainers)}`,
    );
    if (metrics.mobileNavTop !== null && metrics.actionButtonBottom !== null) {
      assert.ok(
        metrics.actionButtonBottom <= metrics.mobileNavTop + 1,
        `${viewport.name}px action button is behind the mobile dock`,
      );
    }
    await page.screenshot({
      path: path.join(screenshotDir, `game-${viewport.name}.png`),
      fullPage: true,
    });
  }

  const nightTarget = gameSession.players.find(
    (player) => player.isAlive && player.isAI && player.role !== 'wolf',
  );
  const witch = gameSession.players.find(
    (player) => player.isAlive && player.role === 'witch',
  );
  assert.ok(nightTarget);
  assert.ok(witch);
  for (const wolf of wolves) {
    const result = await gameSession.dispatch(
      {
        commandId: `responsive-wolf-vote-${wolf.id}`,
        actorId: wolf.id,
        sentAt: Date.now(),
        roomId: gameSession.serialize().state.roomId,
        gameId: gameSession.gameId,
        expectedStageRevision: gameSession.stageRevision,
      },
      { type: 'game.wolf_vote', payload: { targetId: nightTarget.id } },
    );
    assert.equal(result.ok, true);
  }
  const witchResult = await gameSession.dispatch(
    {
      commandId: 'responsive-witch-skip',
      actorId: witch.id,
      sentAt: Date.now(),
      roomId: gameSession.serialize().state.roomId,
      gameId: gameSession.gameId,
      expectedStageRevision: gameSession.stageRevision,
    },
    { type: 'game.skip_night', payload: { action: 'heal' } },
  );
  assert.equal(witchResult.ok, true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (gameSession.serialize().state.dayFlow.stage === 'speech') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(gameSession.serialize().state.dayFlow.stage, 'speech');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('首轮信息报告').waitFor({ timeout: 10_000 });
  await captureGameStage('first-report', { width: 1440, height: 900 });
  await captureGameStage('first-report', { width: 390, height: 844 });
  await captureGameStage('first-report', { width: 768, height: 1024 });

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
