import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { GameSession } from '../session/gameSession';
import { createPlayers, dispatch, initializeSession } from './fixtures';

test('each stage transition publishes a newer revision and next actor actions', async () => {
  const players = createPlayers();
  const session = new GameSession(
    'room-1',
    players,
    new InMemoryEventStore(),
  );
  await initializeSession(session, players);
  const guardian = players.find((player) => player.role === 'guardian')!;
  const seer = players.find((player) => player.role === 'seer')!;
  const wolf = players.find((player) => player.role === 'wolf')!;

  const initial = await session.snapshotFor({
    kind: 'player',
    playerId: guardian.id,
    role: 'guardian',
  });
  await dispatch(session, guardian.id, {
    type: 'game.skip_night',
    payload: { action: 'guard' },
  });
  await dispatch(session, seer.id, {
    type: 'game.skip_night',
    payload: { action: 'check' },
  });
  const wolfSnapshot = await session.snapshotFor({
    kind: 'player',
    playerId: wolf.id,
    role: 'wolf',
  });
  assert.ok(
    wolfSnapshot.gameState.stageRevision! >
      initial.gameState.stageRevision!,
  );
  assert.equal(wolfSnapshot.gameState.nightStage, 'wolf_discussion');
  assert.deepEqual(wolfSnapshot.gameState.allowedActions, [
    'wolf_speak',
    'wolf_vote',
  ]);
  assert.ok(
    (wolfSnapshot.gameState as typeof wolfSnapshot.gameState & {
      deadlineTs?: number | null;
    }).deadlineTs,
  );
});
