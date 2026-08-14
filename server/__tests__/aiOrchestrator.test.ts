import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIProvider } from '../ai/types';
import { AIOrchestrator } from '../ai/orchestrator';
import { InMemoryEventStore } from '../events/store';
import { GameSession } from '../session/gameSession';
import { createPlayers } from './fixtures';

test('invalid AI suggestions use a deterministic validated fallback', async () => {
  const players = createPlayers();
  const session = new GameSession(
    'room-1',
    players,
    new InMemoryEventStore(),
  );
  await session.initialize();
  const guardian = players.find((player) => player.role === 'guardian')!;
  const invalidProvider: AIProvider = {
    async suggest() {
      return {
        command: {
          type: 'game.night_action',
          payload: {
            playerId: guardian.id,
            action: 'guard',
            targetId: 'missing-player',
          },
        },
        reason: 'intentionally invalid target',
      };
    },
  };
  const orchestrator = new AIOrchestrator(invalidProvider);
  const result = await orchestrator.act(session, {
    roomId: 'room-1',
    gameId: session.gameId,
    playerId: guardian.id,
    role: 'guardian',
    phase: 'night',
    stage: 'guard_seer',
    stageRevision: session.stageRevision,
    players,
    allowedCommandTypes: ['game.night_action'],
  });

  assert.equal(result.accepted, true);
  assert.ok(session.serialize().state.night.actions.guardTargetId);
  assert.deepEqual(
    orchestrator.telemetry().map((entry) => entry.status),
    ['started', 'fallback'],
  );
});
