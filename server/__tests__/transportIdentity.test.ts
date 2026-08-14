import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';

const options = {
  roomName: 'Identity room',
  maxPlayers: 12,
  aiCount: 0,
  name: 'Host',
};

test('bound identity rejects impersonation, cross-room, cross-game, and spectator writes', async () => {
  const rooms = new RoomService(
    new InMemoryRoomRepository(),
    new InMemoryEventStore(),
  );
  const created = await rooms.create({ actorId: 'host', options });
  const joined = await rooms.join({
    actorId: 'guest',
    name: 'Guest',
    roomCode: created.room.code,
    joinToken: created.credentials.joinToken,
  });
  const spectator = await rooms.join({
    actorId: 'spectator',
    name: 'Spectator',
    roomCode: created.room.code,
    joinToken: created.credentials.joinToken,
    spectator: true,
  });
  const hostIdentity = await rooms.identity(
    created.room.code,
    'host',
    created.credentials.resumeToken,
  );
  await rooms.startGame(hostIdentity);
  const guestIdentity = await rooms.identity(
    created.room.code,
    'guest',
    joined.credentials.resumeToken,
  );
  const spectatorIdentity = await rooms.identity(
    created.room.code,
    'spectator',
    spectator.credentials.resumeToken,
  );
  const session = rooms.session(created.room.code)!;
  const actor = session.players.find((player) => player.id === 'guest')!;
  const base = {
    commandId: 'identity-test',
    actorId: actor.id,
    sentAt: Date.now(),
    roomId: created.room.id,
    gameId: session.gameId,
    expectedStageRevision: session.stageRevision,
  };
  const command = {
    type: 'game.skip_night' as const,
    payload: { action: 'guard' as const },
  };
  const before = session.serialize().state.sequence;

  assert.equal(
    (
      await rooms.dispatchGame(
        guestIdentity,
        { ...base, actorId: 'host' },
        command,
      )
    ).code,
    'IDENTITY_MISMATCH',
  );
  assert.equal(
    (
      await rooms.dispatchGame(
        guestIdentity,
        { ...base, commandId: 'room', roomId: 'other-room' },
        command,
      )
    ).code,
    'ROOM_MISMATCH',
  );
  assert.equal(
    (
      await rooms.dispatchGame(
        guestIdentity,
        { ...base, commandId: 'game', gameId: 'other-game' },
        command,
      )
    ).code,
    'GAME_MISMATCH',
  );
  assert.equal(
    (
      await rooms.dispatchGame(
        spectatorIdentity,
        { ...base, commandId: 'spectator', actorId: 'spectator' },
        command,
      )
    ).code,
    'SPECTATOR_READ_ONLY',
  );
  assert.equal(session.serialize().state.sequence, before);
  await rooms.close();
});

test('resume requires the server-issued member credential', async () => {
  const rooms = new RoomService(
    new InMemoryRoomRepository(),
    new InMemoryEventStore(),
  );
  const created = await rooms.create({ actorId: 'host', options });
  await assert.rejects(
    rooms.resume(created.room.code, 'host', created.credentials.joinToken),
    /UNAUTHENTICATED/,
  );
  const resumed = await rooms.resume(
    created.room.code,
    'host',
    created.credentials.resumeToken,
  );
  assert.equal(resumed.room.viewer.actorId, 'host');
});
