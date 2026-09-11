import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';
import { projectRoomAccessPayload } from '../transport/socketTransport';
import { confirmRoles, createRequest, startRoom } from './fixtures';

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
  await confirmRoles(session);
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

test('recovery access payload exposes only the room and resume credential allowlists', async () => {
  const rooms = new RoomService(
    new InMemoryRoomRepository(),
    new InMemoryEventStore(),
    { autoDrive: false },
  );
  const created = await rooms.create({
    ...createRequest(rooms, 'host', 'recovery-allowlist', 'Recovery allowlist'),
  });
  const unsafe = {
    ...created,
    session: { authority: 'never-output' },
    room: {
      ...created.room,
      joinToken: 'never-output',
      session: { authority: 'never-output' },
    },
    credentials: {
      ...created.credentials,
      joinToken: 'never-output',
      omniscientToken: 'never-output',
      internalCredentialRef: 'never-output',
    },
  } as unknown as Parameters<typeof projectRoomAccessPayload>[0];

  const payload = projectRoomAccessPayload(unsafe, 'resume');

  assert.deepEqual(Object.keys(payload).sort(), ['credentials', 'room']);
  assert.deepEqual(Object.keys(payload.credentials), ['resumeToken']);
  assert.deepEqual(
    Object.keys(payload.room).sort(),
    [
      'code', 'computerPlayerMode', 'computerPlayerStatus', 'config', 'configLocked',
      'configRevision', 'counts', 'createdAt', 'id', 'members', 'name',
      'roomRevision', 'startCheck', 'status', 'viewer',
    ].sort(),
  );
  assert.doesNotMatch(JSON.stringify(payload), /never-output|joinToken|omniscientToken|session/);
  await rooms.close();
});
