import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import type {
  EventAppendRequest,
  EventStore,
  StoredEvent,
} from '../shared/events';
import type { GameCommand, GameCommandMeta } from '../shared/protocol';
import type { Player } from '../shared/types';
import { InMemoryRoomRepository } from '../server/rooms/repository';
import { RoomService } from '../server/rooms/roomService';
import type { GameSession } from '../server/session/gameSession';
import { bindSocketTransport } from '../server/transport/socketTransport';

const workspace = process.cwd();
/**
 * This browser fixture never restores its in-process GameSession. Keep only
 * the latest full recovery checkpoint so dozens of setup turns do not retain
 * dozens of cloned AI memory boards. Event versions and all user-visible
 * events stay intact; production event stores are unaffected.
 */
class CompactVerifierEventStore implements EventStore {
  private readonly streams = new Map<string, StoredEvent[]>();

  async append(request: EventAppendRequest): Promise<StoredEvent[]> {
    const current = this.streams.get(request.streamId) ?? [];
    assert.equal(current.length, request.expectedVersion);
    for (const stored of current) {
      if (stored.event.eventType === 'game.state_updated') {
        delete stored.event.payload.sessionState;
      }
    }
    const stored = request.events.map((event, index) => ({
      streamId: request.streamId,
      streamVersion: current.length + index + 1,
      event,
    }));
    this.streams.set(request.streamId, [...current, ...stored]);
    return stored;
  }

  async read(streamId: string, afterSequence = 0): Promise<StoredEvent[]> {
    return (this.streams.get(streamId) ?? []).filter(
      ({ event }) => event.sequence > afterSequence,
    );
  }

  async remove(streamId: string): Promise<void> {
    this.streams.delete(streamId);
  }
}

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
  'w3-p1-03-vote-round',
);
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (session.serialize().state.dayFlow.stage !== 'dawn') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  for (let step = 0; step < 100; step += 1) {
    const state = session.serialize().state;
    if (state.dayFlow.stage === 'voting') break;
    assert.equal(state.gameState.day, day);
    assert.ok(
      state.dayFlow.stage === 'speech' || state.dayFlow.stage === 'discussion',
      `unexpected day speech stage: ${state.dayFlow.stage}`,
    );
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
        if (clipsX) { left = Math.max(left, ancestorRect.left); right = Math.min(right, ancestorRect.right); }
        if (clipsY) { top = Math.max(top, ancestorRect.top); bottom = Math.min(bottom, ancestorRect.bottom); }
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
    overlaps,
    mobileNavTop: (() => {
      const nav = document.querySelector('.v3-mobile-match-nav');
      const rect = nav?.getBoundingClientRect();
      return rect && rect.width > 0 && rect.height > 0 ? rect.top : null;
    })(),
    voteButtonBottom: document.querySelector('.v3-action-panel__footer button')?.getBoundingClientRect().bottom ?? null
  };
})()`;

const socketHttpServer = createHttpServer();
const io = new Server(socketHttpServer, {
  cors: { origin: true, credentials: true },
});
const rooms = new RoomService(
  new InMemoryRoomRepository(),
  new CompactVerifierEventStore(),
  {
    autoDrive: false,
    // The role deck is the only randomized input this fixture needs. Keep
    // it deterministic so the night-completion setup cannot occasionally
    // miss one of the required roles; production randomness is unchanged.
    roleRandomIndex: () => 0,
  },
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
let page = await context.newPage();
const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const requestFailures: Array<{ url: string; error: string }> = [];

const observePage = (target: typeof page): void => {
  target.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  target.on('pageerror', (error) => pageErrors.push(error.message));
  target.on('requestfailed', (request) => {
    requestFailures.push({
      url: request.url(),
      error: request.failure()?.errorText ?? 'failed',
    });
  });
};
observePage(page);

try {
  await page.addInitScript((url) => {
    localStorage.setItem('wolf-server-url', url);
  }, serverUrl);
  await page.goto(appUrl, { waitUntil: 'commit', timeout: 30_000 });
  const createRoomButton = page.getByRole('button', { name: '创建房间', exact: true });
  await createRoomButton.waitFor({ timeout: 90_000 });
  await createRoomButton.click();
  await page.waitForURL(/\/rooms\/[A-Z2-9]{6}\/waiting$/, {
    timeout: 10_000,
  });
  const roomCode = page.url().split('/').at(-2)!;
  await page.getByRole('heading', { name: '安排玩家席位' }).waitFor();
  const startGameButton = page.getByRole('button', { name: '开始游戏' });
  if (await startGameButton.count() === 0) {
    await page.getByRole('button', { name: '开始准备' }).click();
  }
  if (!await startGameButton.isEnabled()) {
    await page.getByRole('button', { name: '确认准备' }).click();
  }
  await startGameButton.click();
  await page.locator('.v3-game-workspace').waitFor({ timeout: 10_000 });

  const session = rooms.session(roomCode);
  assert.ok(session);
  if (session.serialize().state.gameState.phase === 'role_confirm') {
    for (const player of session.players.filter((candidate) => !candidate.isAI)) {
      if (session.serialize().state.roleConfirmations[player.id] === true) continue;
      await dispatch(session, player.id, {
        type: 'game.confirm_role',
        payload: {},
      });
    }
  }
  const humanPlayer = session.players.find((player) => !player.isAI)!;
  const revoteCandidates = session.players.filter(
    (player) => player.isAlive && player.id !== humanPlayer.id,
  ).slice(0, 2);
  assert.equal(revoteCandidates.length, 2);
  const [firstCandidate, secondCandidate] = revoteCandidates;
  const killTarget = session.players.find(
    (player) => player.order === 12,
  )!;

  // Keep the durable browser identity but disconnect the page while the
  // fixture advances dozens of authoritative speech turns. This avoids
  // constructing a redundant socket projection for every setup command and
  // mirrors a user leaving the page before re-entering during voting.
  await page.close();
  // AI decisions are disabled in this fixture and all setup commands are
  // dispatched explicitly. Empty the test session's private memory map so
  // each synthetic speech does not spend time persisting eleven unused
  // strategy boards. Production sessions and player-facing projections are
  // unchanged.
  (session as unknown as {
    state: { aiMemories: Record<string, never> };
  }).state.aiMemories = {};
  await completeNight(session, killTarget.id, killTarget.id);
  assert.equal(session.players.every((player) => player.isAlive), true);
  await skipDaySpeeches(session, 1);
  await castBalancedTie(session, firstCandidate, secondCandidate);
  assert.equal(session.serialize().state.dayFlow.voteRound, 2);
  assert.deepEqual(
    [...session.serialize().state.dayFlow.voteCandidates].sort(),
    [firstCandidate.id, secondCandidate.id].sort(),
  );

  page = await context.newPage();
  observePage(page);
  await page.goto(`${appUrl}/rooms/${roomCode}/play`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForTimeout(500);
  const reloadDiagnostics = await page.evaluate(() => ({
    path: window.location.pathname,
    navLabels: [...document.querySelectorAll('.v3-mobile-match-nav button')]
      .map((button) => button.textContent?.trim() ?? ''),
    headings: [...document.querySelectorAll('h1, h2')]
      .map((heading) => heading.textContent?.trim() ?? '')
      .slice(0, 8),
  }));
  assert.equal(reloadDiagnostics.path, `/rooms/${roomCode}/play`);
  await page.locator('.v3-game-workspace').waitFor({
    state: 'attached',
    timeout: 30_000,
  }).catch(() => {
    throw new Error(
      `game workspace did not recover after reload: ${JSON.stringify(reloadDiagnostics)}`,
    );
  });
  await page.locator('.v3-action-panel').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const actionDiagnostics = await page.evaluate(async () => {
    const module = await import('/src/stores/v3Store.ts');
    const state = module.useV3Store.getState();
    return {
      path: window.location.pathname,
      connected: state.connected,
      recovering: state.recovering,
      syncStatus: state.syncStatus,
      syncError: state.syncError,
      authorityStatus: state.authorityStatus,
      error: state.error,
      roomStatus: state.room?.status ?? null,
      actorId: state.session?.actorId ?? null,
      viewer: state.snapshot?.viewer ?? null,
      phase: state.snapshot?.gameState.phase ?? null,
      dayStage: state.snapshot?.gameState.dayStage ?? null,
      voteRound: state.snapshot?.gameState.voteRound ?? null,
      voteCandidates: state.snapshot?.gameState.voteCandidates ?? [],
      allowedActions: state.snapshot?.gameState.allowedActions ?? [],
      relevantEvents: state.events
        .filter((event) =>
          event.eventType === 'day.started' ||
          event.eventType === 'day.voting_started' ||
          event.eventType === 'day.revote_required'
        )
        .map((event) => ({
          sequence: event.sequence,
          type: event.eventType,
          candidates: event.payload.candidates ?? null,
        })),
    };
  });
  assert.equal(actionDiagnostics.dayStage, 'voting');
  assert.deepEqual(
    {
      connected: actionDiagnostics.connected,
      recovering: actionDiagnostics.recovering,
      syncStatus: actionDiagnostics.syncStatus,
      authorityStatus: actionDiagnostics.authorityStatus,
    },
    {
      connected: true,
      recovering: false,
      syncStatus: 'synced',
      authorityStatus: 'authorized',
    },
    `game actions did not become ready after re-entry: ${JSON.stringify(actionDiagnostics)}`,
  );
  assert.ok(
    actionDiagnostics.allowedActions.includes('vote'),
    `vote action was not projected to the host: ${JSON.stringify({
      browser: actionDiagnostics,
      server: {
        allowedActors: session.serialize().state.gameState.allowedActors,
        players: session.players.map((player) => ({
          id: player.id,
          order: player.order,
          isAI: player.isAI,
          isAlive: player.isAlive,
        })),
      },
    })}`,
  );
  const actionDiagnosticsDom = await page.evaluate(() => ({
    actionPanelText: document.querySelector('.v3-action-panel')?.textContent?.trim() ?? '',
    actionControls: [...document.querySelectorAll('.v3-action-panel button')]
      .map((button) => ({
        text: button.textContent?.trim() ?? '',
        role: button.getAttribute('role'),
        visible: (() => {
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })(),
      })),
    targetGrid: document.querySelector('.v3-target-grid')?.textContent?.trim() ?? null,
    mobileSection: document.querySelector('.v3-game-workspace')?.getAttribute('data-mobile-section') ?? null,
    targetButtons: [...document.querySelectorAll('.v3-target-grid button')]
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          text: button.textContent?.trim() ?? '',
          visible: rect.width > 0 && rect.height > 0,
        };
      }),
  }));
  // The action selector is a tablist in the current GamePage, but this
  // verifier deliberately accepts the equivalent button/title presentation
  // used by older responsive projections. The target grid is the authoritative
  // proof that the vote action is active.
  const voteSelector = page
    .locator('.v3-action-panel button')
    .filter({ hasText: /^投票$/ })
    .first();
  if (await voteSelector.count() > 0) {
    await voteSelector.waitFor({ state: 'visible', timeout: 10_000 });
  } else {
    assert.match(
      actionDiagnosticsDom.actionPanelText,
      /投票/,
      `vote action control was not rendered: ${JSON.stringify(actionDiagnosticsDom)}`,
    );
  }
  const targetButtons = page.locator('.v3-target-grid button');
  assert.equal(
    await targetButtons.count(),
    2,
    `revote candidates were not rendered: ${JSON.stringify({
      browser: actionDiagnostics,
      dom: actionDiagnosticsDom,
    })}`,
  );
  await targetButtons.first().waitFor({ state: 'visible' });
  assert.deepEqual(
    await targetButtons.evaluateAll((buttons) =>
      buttons.map(
        (button) =>
          button.querySelector('span')?.textContent?.trim() ?? '',
      ),
    ),
    [
      firstCandidate.order.toString().padStart(2, '0'),
      secondCandidate.order.toString().padStart(2, '0'),
    ],
  );
  const firstTargetButton = targetButtons.filter({
    hasText: new RegExp(`^${firstCandidate.order.toString().padStart(2, '0')}`),
  });
  const secondTargetButton = targetButtons.filter({
    hasText: new RegExp(`^${secondCandidate.order.toString().padStart(2, '0')}`),
  });
  await firstTargetButton.click();
  assert.equal(
    await firstTargetButton.evaluate(
      (button) => button.classList.contains('is-selected'),
    ),
    true,
  );
  const voteSubmitButton = page
    .locator('.v3-action-panel__footer button')
    .filter({ hasText: /确认(?:修改)?投票/ });
  await voteSubmitButton.waitFor({ state: 'visible' });
  assert.equal(await voteSubmitButton.count(), 1);
  assert.equal(await voteSubmitButton.isEnabled(), true);

  // Submit once, then change the target and submit again. This proves the
  // client keeps the current round's ballot instead of treating a changed
  // selection as a second vote or losing the first vote in the UI.
  await voteSubmitButton.click();
  const voteStatus = page.locator('.v3-vote-status');
  await voteStatus.filter({ hasText: '已投给：' }).waitFor({
    state: 'visible',
    timeout: 10_000,
  });
  await voteStatus.filter({ hasText: '投票完成，等待其他玩家投票' }).waitFor({ state: 'visible' });
  await voteStatus.filter({ hasText: '已投票人数 / 当前存活人数' }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('.v3-target-grid').count(), 0);
  assert.equal(await page.locator('.v3-action-panel__footer button').count(), 0);
  assert.equal(session.serialize().state.dayFlow.votes[humanPlayer.id], firstCandidate.id);

  const editVoteButton = page.getByRole('button', { name: '更改投票', exact: true });
  await editVoteButton.waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await editVoteButton.isEnabled(), true);
  await editVoteButton.click();
  await secondTargetButton.waitFor({ state: 'visible' });
  await secondTargetButton.click();
  assert.equal(
    await secondTargetButton.evaluate(
      (button) => button.classList.contains('is-selected'),
    ),
    true,
  );
  const changeVoteButton = page.locator('.v3-action-panel__footer button')
    .filter({ hasText: '确认修改投票' });
  await changeVoteButton.waitFor({ state: 'visible' });
  await changeVoteButton.click();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (session.serialize().state.dayFlow.votes[humanPlayer.id] === secondCandidate.id) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(session.serialize().state.dayFlow.votes[humanPlayer.id], secondCandidate.id);

  assert.equal(session.serialize().state.gameState.phase, 'day');
  assert.equal(session.serialize().state.dayFlow.stage, 'voting');
  assert.equal(session.serialize().state.dayFlow.voteRound, 2);

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    if (viewport.width < 768) {
      await page.getByRole('button', { name: '更改投票', exact: true }).scrollIntoViewIfNeeded();
      await page.waitForTimeout(100);
    }
    const finalMetrics = await page.evaluate(layoutMetricsScript) as {
      documentWidth: number;
      bodyWidth: number;
      viewportWidth: number;
      clipped: unknown[];
      overlaps: unknown[];
      mobileNavTop: number | null;
      voteButtonBottom: number | null;
    };
    await page.screenshot({
      path: path.join(screenshotDir, `revote-${viewport.name}.png`),
      fullPage: true,
    });
    assert.ok(
      finalMetrics.documentWidth <= viewport.width + 1,
      `${viewport.name}px document overflow: ${JSON.stringify(finalMetrics)}`,
    );
    assert.ok(
      finalMetrics.bodyWidth <= viewport.width + 1,
      `${viewport.name}px body overflow: ${JSON.stringify(finalMetrics)}`,
    );
    assert.deepEqual(
      finalMetrics.clipped,
      [],
      `${viewport.name}px clipped controls`,
    );
    assert.deepEqual(
      finalMetrics.overlaps,
      [],
      `${viewport.name}px overlapping controls`,
    );
    if (finalMetrics.mobileNavTop !== null && finalMetrics.voteButtonBottom !== null) {
      assert.ok(
        finalMetrics.voteButtonBottom <= finalMetrics.mobileNavTop + 1,
        `${viewport.name}px vote button is behind the mobile dock`,
      );
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
    `W3-P1-03 vote-round verification passed at ${viewports.map(({ name }) => name).join('/')} px.`,
  );
  console.log(
    `Revote candidates: ${firstCandidate.order.toString().padStart(2, '0')}, ${secondCandidate.order.toString().padStart(2, '0')}`,
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
