import assert from 'node:assert/strict';
import test from 'node:test';
import { GameSession } from '../session/gameSession';
import { InMemoryEventStore } from '../events/store';
import { createPlayers } from './fixtures';

test('GameSession rebuilds private cognition from the event stream and prepares a bounded packet', async () => {
  const players = createPlayers('room-cognition').slice(0, 4);
  const store = new InMemoryEventStore();
  const session = new GameSession('room-cognition', players, store);
  await session.initialize();

  const packet = session.prepareAICognition({
    ownerId: players[0].id,
    stageRevision: session.stageRevision,
    legalActions: ['confirm_role'],
    legalTargetIds: [],
  });

  assert.ok(packet);
  assert.equal(packet.ownerId, players[0].id);
  assert.ok(packet.facts.some((fact) => fact.kind === 'game_started'));
  assert.ok(packet.facts.length <= 12);
  assert.deepEqual(packet.legalActions, ['confirm_role']);

  // The second session has no cognition snapshot to copy; it must rebuild the
  // same private projection from the committed event stream.
  const recovered = new GameSession(
    'room-cognition',
    players,
    store,
    session.serialize(),
  );
  await recovered.initialize();
  const recoveredPacket = recovered.prepareAICognition({
    ownerId: players[0].id,
    stageRevision: recovered.stageRevision,
    legalActions: ['confirm_role'],
    legalTargetIds: [],
  });
  assert.deepEqual(
    recoveredPacket?.facts.map((fact) => fact.id),
    packet.facts.map((fact) => fact.id),
  );
});
