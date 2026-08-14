import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';

test('successful ACK and event replay use the same viewer projection', async () => {
  const rooms = new RoomService(
    new InMemoryRoomRepository(),
    new InMemoryEventStore(),
    { autoDrive: false },
  );
  const created = await rooms.create({
    actorId: 'host',
    options: {
      roomName: 'ACK projection',
      maxPlayers: 12,
      aiCount: 0,
      name: 'Host',
    },
  });
  const identity = await rooms.identity(
    created.room.code,
    'host',
    created.credentials.resumeToken,
  );
  const started = await rooms.startGame(identity);
  const rebound = await rooms.identity(
    created.room.code,
    'host',
    created.credentials.resumeToken,
  );
  const session = rooms.session(created.room.code)!;
  const guardian = session.players.find((player) => player.role === 'guardian')!;
  const seer = session.players.find((player) => player.role === 'seer')!;
  await session.dispatch(
    {
      commandId: 'setup-guard',
      actorId: guardian.id,
      sentAt: Date.now(),
      roomId: created.room.id,
      gameId: started.gameId!,
      expectedStageRevision: session.stageRevision,
    },
    {
      type: 'game.skip_night',
      payload: { action: 'guard' },
    },
  );
  await session.dispatch(
    {
      commandId: 'setup-seer',
      actorId: seer.id,
      sentAt: Date.now(),
      roomId: created.room.id,
      gameId: started.gameId!,
      expectedStageRevision: session.stageRevision,
    },
    {
      type: 'game.skip_night',
      payload: { action: 'check' },
    },
  );
  const actionable = await rooms.snapshot(rebound);
  const result = await rooms.dispatchGame(
    rebound,
    {
      commandId: 'ack-project',
      actorId: 'host',
      sentAt: Date.now(),
      roomId: created.room.id,
      gameId: started.gameId!,
      expectedStageRevision: actionable.gameState.stageRevision!,
    },
    {
      type: 'game.wolf_speak',
      payload: { content: 'ACK_PRIVATE_WOLF_MESSAGE' },
    },
  );
  assert.equal(result.ok, true);
  const replay = await rooms.events(rebound, actionable.lastSequence);
  assert.deepEqual(result.events, replay);
  const payload = JSON.stringify(result.events);
  assert.doesNotMatch(payload, /game\.state_updated/);
  assert.doesNotMatch(payload, /"role":"wolf"/);
  assert.doesNotMatch(payload, /joinToken|omniscientToken|resumeToken|session/);
  await rooms.close();
});
