import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import type { GameCommand, GameCommandMeta } from '../shared/protocol';
import type { Player } from '../shared/types';
import { InMemoryEventStore } from '../server/events/store';
import { InMemoryRoomRepository } from '../server/rooms/repository';
import { RoomService } from '../server/rooms/roomService';
import type { GameSession } from '../server/session/gameSession';
import { bindSocketTransport } from '../server/transport/socketTransport';

const workspace = process.cwd();
const screenshotDir = path.join(
  workspace,
  'artifacts',
  'w3-p1-03-vote-round',
);
const viewports = [
  { name: '390', width: 390, height: 844 },
  { name: '768', width: 768, height: 1024 },
  { name: '1440', width: 1440, height: 1000 },
] as const;

await mkdir(screenshotDir, { recursive: true });

let commandSequence = 0;
const dispatch = async (
  session: GameSession,
  actorId: string,
  command: GameCommand,
): Promise<void> => {
  commandSequence += 1;
  const state = session.serialize().state;
  const meta: GameCommandMeta = {
    commandId: `w3-p1-03-${commandSequence}`,
    actorId,
    sentAt: Date.now(),
    roomId: state.roomId,
    gameId: state.gameId,
    expectedStageRevision: session.stageRevision,
  };
  const result = await session.dispatch(meta, command);
  assert.equal(
    result.ok,
    true,
    `${command.type} rejected for ${actorId}: ${result.code ?? 'unknown'}`,
  );
};

const livingRole = (
  session: GameSession,
  role: NonNullable<Player['role']>,
): Player =>
  session.players.find(
    (player) => player.isAlive && player.role === role,
  )!;

const completeNight = async (
  session: GameSession,
  killTargetId: string,
  guardTargetId: string | null,
): Promise<void> => {
  const guardian = livingRole(session, 'guardian');
  const seer = livingRole(session, 'seer');
  const wolves = session.players.filter(
    (player) => player.isAlive && player.role === 'wolf',
  );
  const witch = livingRole(session, 'witch');

  if (guardTargetId) {
    await dispatch(session, guardian.id, {
      type: 'game.night_action',
      payload: {
        playerId: guardian.id,
        action: 'guard',
        targetId: guardTargetId,
      },
    });
  } else {
    await dispatch(session, guardian.id, {
      type: 'game.skip_night',
      payload: { action: 'guard' },
    });
  }
  await dispatch(session, seer.id, {
    type: 'game.skip_night',
    payload: { action: 'check' },
  });
  for (let round = 1; round <= 2; round += 1) {
    for (const wolf of wolves) {
      await dispatch(session, wolf.id, {
        type: 'game.wolf_speak',
        payload: { content: `第${round}轮确认目标与理由。` },
      });
    }
  }
  for (const wolf of wolves) {
    await dispatch(session, wolf.id, {
      type: 'game.wolf_vote',
      payload: { targetId: killTargetId },
    });
  }
  await dispatch(session, witch.id, {
    type: 'game.skip_night',
    payload: { action: 'heal' },
  });
  assert.equal(session.serialize().state.gameState.phase, 'day');
};

const skipDaySpeeches = async (
  session: GameSession,
  day: number,
): Promise<void> => {
  for (let step = 0; step < 20; step += 1) {
    const state = session.serialize().state;
    if (state.dayFlow.stage === 'voting') break;
    assert.equal(state.gameState.day, day);
    assert.equal(state.dayFlow.stage, 'speech');
    assert.ok(state.gameState.currentSpeaker);
    await dispatch(session, state.gameState.currentSpeaker, {
      type: 'game.skip_speech',
      payload: {},
    });
  }
  const state = session.serialize().state;
  assert.equal(state.gameState.day, day);
  assert.equal(state.dayFlow.stage, 'voting');
  assert.equal(state.dayFlow.voteRound, 1);
};

const castBalancedTie = async (
  session: GameSession,
  first: Player,
  second: Player,
): Promise<void> => {
  const state = session.serialize().state;
  const voters = session.players.filter(
    (player) =>
      player.isAlive &&
      (state.dayFlow.voteRound === 1 ||
        (player.id !== first.id && player.id !== second.id)),
  );
  assert.equal(voters.length % 2, 0);
  let firstVotes = 0;
  let secondVotes = 0;

  for (const voter of voters) {
    let targetId: string;
    if (voter.id === first.id) {
      targetId = second.id;
      secondVotes += 1;
    } else if (voter.id === second.id) {
      targetId = first.id;
      firstVotes += 1;
    } else if (firstVotes <= secondVotes) {
      targetId = first.id;
      firstVotes += 1;
    } else {
      targetId = second.id;
      secondVotes += 1;
    }
    await dispatch(session, voter.id, {
      type: 'game.vote',
      payload: { targetId },
    });
  }
  assert.equal(firstVotes, secondVotes);
};

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
  await createDialog.getByLabel('显示名称').fill('W3 Vote Host');
  await createDialog.getByLabel('房间名称').fill('W3 Vote Round');
  await createDialog
    .getByRole('button', { name: '创建并进入' })
    .click();
  await page.waitForURL(/\/room\/[A-Z2-9]{6}$/, {
    timeout: 10_000,
  });
  const roomCode = page.url().split('/').at(-1)!;
  await page.getByRole('heading', { name: '等待房间' }).waitFor();
  await page.getByRole('button', { name: '开始对局' }).click();
  await page.getByRole('heading', { name: '行动面板' }).waitFor({
    timeout: 10_000,
  });

  const session = rooms.session(roomCode);
  assert.ok(session);
  const p09 = session.players.find((player) => player.order === 9)!;
  const p10 = session.players.find((player) => player.order === 10)!;
  const p11 = session.players.find((player) => player.order === 11)!;

  await completeNight(session, p11.id, p11.id);
  assert.equal(session.players.every((player) => player.isAlive), true);
  await skipDaySpeeches(session, 1);
  await castBalancedTie(session, p09, p10);
  assert.equal(session.serialize().state.dayFlow.voteRound, 2);
  assert.deepEqual(
    [...session.serialize().state.dayFlow.voteCandidates].sort(),
    [p09.id, p10.id].sort(),
  );

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: '投票' }).waitFor({
    timeout: 10_000,
  });
  const targetButtons = page.locator('.v3-target-grid button');
  await targetButtons.first().waitFor();
  assert.deepEqual(
    await targetButtons.evaluateAll((buttons) =>
      buttons.map(
        (button) =>
          button.querySelector('span')?.textContent?.trim() ?? '',
      ),
    ),
    ['09', '10'],
  );
  await targetButtons.filter({ hasText: 'AI 9' }).click();
  assert.equal(
    await targetButtons.filter({ hasText: 'AI 9' }).evaluate(
      (button) => button.classList.contains('is-selected'),
    ),
    true,
  );

  await castBalancedTie(session, p09, p10);
  assert.equal(session.serialize().state.gameState.phase, 'night');
  assert.equal(session.serialize().state.gameState.day, 2);
  await completeNight(session, p10.id, null);
  assert.equal(
    session.players.find((player) => player.id === p10.id)?.isAlive,
    false,
  );
  await skipDaySpeeches(session, 2);
  assert.deepEqual(
    session.serialize().state.gameState.allowedActions,
    ['vote', 'abstain'],
  );

  const refreshed = await page.evaluate(async () => {
    const module = await import('/src/stores/v3Store.ts');
    return module.useV3Store.getState().refreshSnapshot();
  });
  assert.equal(refreshed, true);
  await page.getByRole('tab', { name: '弃票' }).waitFor({
    timeout: 10_000,
  });
  await page.getByText('第 2 天 · 投票', { exact: true }).first().waitFor();

  const expectedOrders = session.players
    .filter(
      (player) =>
        player.isAlive &&
        player.id !== session.players.find((item) => item.order === 1)!.id,
    )
    .map((player) => player.order.toString().padStart(2, '0'));
  assert.deepEqual(
    await targetButtons.evaluateAll((buttons) =>
      buttons.map(
        (button) =>
          button.querySelector('span')?.textContent?.trim() ?? '',
      ),
    ),
    expectedOrders,
  );
  assert.equal(
    await page.locator('.v3-target-grid button.is-selected').count(),
    0,
  );
  assert.equal(
    await targetButtons.filter({ hasText: 'AI 9' }).count(),
    1,
  );
  assert.equal(
    await targetButtons.filter({ hasText: 'AI 10' }).count(),
    0,
  );

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    const metrics = await page.evaluate(layoutMetricsScript) as {
      documentWidth: number;
      bodyWidth: number;
      viewportWidth: number;
      clipped: unknown[];
      overlaps: unknown[];
    };
    await page.screenshot({
      path: path.join(screenshotDir, `day-2-vote-${viewport.name}.png`),
      fullPage: true,
    });
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
    `W3-P1-03 vote-round verification passed at ${viewports.map(({ name }) => name).join('/')} px.`,
  );
  console.log(`Day 2 legal target orders: ${expectedOrders.join(', ')}`);
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
