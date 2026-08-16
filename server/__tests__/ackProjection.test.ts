import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';
import { createRequest, startRoom } from './fixtures';

test('successful ACK and event replay use the same viewer projection', async () => {
  const rooms = new RoomService(
    new InMemoryRoomRepository(),
    new InMemoryEventStore(),
    { autoDrive: false },
  );
  const created = await rooms.create({
    ...createRequest(rooms, 'host', 'ack-create', 'ACK projection'),
  });
  const identity = await rooms.identity(
    created.room.code,
    'host',
    created.credentials.resumeToken,
  );
  const started = await startRoom(rooms, identity, 'ack');
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
  const wolf = (await rooms.getRecord(created.room.code))?.players.find((player) => player.role === 'wolf');
  assert.ok(wolf);
  const wolfMember = (await rooms.getRecord(created.room.code))?.members.find((member) => member.id === wolf.id);
  assert.ok(wolfMember);
  const wolfIdentity = await rooms.identity(created.room.code, wolf.id, wolfMember.resumeToken);
  const result = await rooms.dispatchGame(
    wolfIdentity,
    {
      commandId: 'ack-project',
      actorId: wolf.id,
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
  const replay = await rooms.events(wolfIdentity, actionable.lastSequence);
  assert.deepEqual(result.events, replay);
  const payload = JSON.stringify(result.events);
  assert.doesNotMatch(payload, /game\.state_updated/);
  assert.doesNotMatch(payload, /"role":"wolf"/);
  assert.doesNotMatch(payload, /joinToken|omniscientToken|resumeToken|session/);
  await rooms.close();
});
