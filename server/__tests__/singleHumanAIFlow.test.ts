import assert from 'node:assert/strict';
import test from 'node:test';
import type { AISuggestion, AIProvider } from '../ai/types';
import { InMemoryEventStore } from '../events/store';
import { SessionCoordinator } from '../rooms/sessionCoordinator';
import type { RoomRecord } from '../rooms/types';
import { GameSession } from '../session/gameSession';
import { createPlayers, dispatch } from './fixtures';
import { FakeClock } from './fakeClock';

const singleHumanRoom = (): RoomRecord => ({
  id: 'single-human-ai-room',
  code: 'SINGLEAI',
  name: 'Single human AI flow',
  joinToken: 'test',
  omniscientToken: 'test-omniscient',
  hostId: 'human',
  maxPlayers: 12,
  status: 'playing',
  auto: false,
  debugMode: false,
  configLocked: true,
  roomRevision: 1,
  configRevision: 1,
  members: [],
  players: [],
  createdAt: 1,
});

/** A deterministic stand-in for successful provider responses in each night turn. */
const mockNightProvider: AIProvider = {
  mode: 'test-deterministic',
  async suggest(context): Promise<AISuggestion> {
    if (context.allowedCommandTypes.includes('game.night_action')) {
      if (context.role === 'guardian') {
        return {
          command: {
            type: 'game.night_action',
            payload: {
              playerId: context.playerId,
              action: 'guard',
              targetId: context.playerId,
            },
          },
          reason: 'mock guardian action',
        };
      }
      if (context.role === 'seer') {
        return {
          command: {
            type: 'game.night_action',
            payload: {
              playerId: context.playerId,
              action: 'check',
              targetId: 'wolf-3',
            },
          },
          reason: 'mock seer action',
        };
      }
      const notice = context.projectedContext?.privateEvents.find(
        (event) => event.eventType === 'witch.kill_notice',
      );
      const killTargetId = notice && typeof notice.payload === 'object' && notice.payload !== null
        ? (notice.payload as { killTargetId?: unknown }).killTargetId
        : undefined;
      return {
        command: {
          type: 'game.night_action',
          payload: {
            playerId: context.playerId,
            action: 'heal',
            targetId: typeof killTargetId === 'string' ? killTargetId : 'villager-10',
          },
        },
        reason: 'mock witch action',
      };
    }
    if (context.allowedCommandTypes.includes('game.wolf_speak')) {
      return {
        command: {
          type: 'game.wolf_speak',
          payload: { content: 'mock wolf discussion' },
        },
        reason: 'mock wolf discussion',
      };
    }
    if (context.allowedCommandTypes.includes('game.wolf_vote')) {
      return {
        command: {
          type: 'game.wolf_vote',
          payload: { targetId: 'villager-10' },
        },
        reason: 'mock wolf vote',
      };
    }
    if (context.allowedCommandTypes.includes('game.speak')) {
      return {
        command: {
          type: 'game.speak',
          payload: { content: 'mock daytime speech' },
        },
        reason: 'mock daytime speech',
      };
    }
    throw new Error(`unexpected AI action: ${context.allowedCommandTypes.join(',')}`);
  },
};

test('single-human first night AI actions advance through dawn into human speech', async () => {
  const clock = new FakeClock();
  const players = createPlayers('single-human-ai-room');
  const human = players.find((player) => player.role === 'villager')!;
  for (const player of players) player.isAI = player.id !== human.id;

  const session = new GameSession(
    'single-human-ai-room',
    players,
    new InMemoryEventStore(),
    undefined,
    { now: clock.now, rng: () => 0, scheduler: clock, stageDurationMs: 100 },
  );
  const room = singleHumanRoom();
  const coordinator = new SessionCoordinator({
    getRoom: async () => room,
    getSession: () => session,
    providerForRoom: async () => mockNightProvider,
    now: clock.now,
    aiSpeechDelayMinMs: 0,
    aiSpeechDelayMaxMs: 0,
  });

  try {
    await session.initialize();
    const confirmation = await dispatch(session, human.id, {
      type: 'game.confirm_role',
      payload: {},
    });
    assert.equal(confirmation.ok, true);
    assert.equal(session.serialize().state.gameState.phase, 'night');

    for (let turn = 0; turn < 30; turn += 1) {
      const state = session.serialize().state;
      if (state.gameState.phase === 'day') break;
      const sequenceBefore = state.sequence;
      await coordinator.scheduleEligibleAI({ roomCode: room.code });
      assert.ok(
        session.serialize().state.sequence > sequenceBefore,
        `AI turn ${turn + 1} did not commit an event`,
      );
    }

    let state = session.serialize().state;
    assert.equal(state.gameState.phase, 'day');
    assert.equal(state.dayFlow.stage, 'dawn');
    assert.equal(state.gameState.deadlineTs, clock.now());

    // Dawn is a passive hand-off. It must fire even though actionable
    // single-human stages intentionally wait forever for the human.
    await clock.advance(0);
    state = session.serialize().state;
    assert.equal(state.dayFlow.stage, 'speech');
    assert.equal(state.gameState.phase, 'day');
    assert.equal(state.gameState.deadlineTs, null);
    assert.equal(state.gameState.currentSpeaker, 'guardian-1');

    // AI can continue public speeches until the real player turn, then waits.
    while (
      state.dayFlow.stage === 'speech' &&
      state.gameState.currentSpeaker !== human.id
    ) {
      const sequenceBefore = state.sequence;
      await coordinator.scheduleEligibleAI({ roomCode: room.code });
      state = session.serialize().state;
      assert.ok(state.sequence > sequenceBefore);
    }
    assert.equal(state.dayFlow.stage, 'speech');
    assert.equal(state.gameState.currentSpeaker, human.id);
  } finally {
    await coordinator.close();
    session.dispose();
  }
});
