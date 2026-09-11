import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';

const optionsFor = (
  rooms: RoomService,
  roomName: string,
  overrides: Record<string, unknown> = {},
) => {
  const catalog = rooms.getCatalog();
  const preset = catalog.rolePresets.find((item) => item.enabled)!;
  return {
    catalogVersion: catalog.catalogVersion,
    roomName,
    creator: { name: 'Host', avatarId: 'avatar-player' },
    mode: 'human' as const,
    visibility: 'listed' as const,
    maxPlayers: preset.playerCount,
    minHumanPlayers: preset.playerCount,
    computerSeats: 0,
    aiFillPolicy: 'none' as const,
    roleSetup: { ...preset.roleSetup },
    rolePresetId: preset.id,
    rulesetId: preset.rulesetId,
    rulesetVersion: preset.rulesetVersion,
    readyPolicy: 'all_connected_humans' as const,
    allowPublicSpectators: false,
    reviewEnabled: true,
    ...overrides,
  };
};

test('public listing filters namespace, visibility, lifecycle and TTL', async () => {
  let now = 1_000;
  const repository = new InMemoryRoomRepository();
  const rooms = new RoomService(repository, new InMemoryEventStore(), {
    environment: 'test',
    deploymentNamespace: 'e2e-a',
    waitingRoomTtlMs: 100,
    endedRoomTtlMs: 100,
    roomSweepIntervalMs: 0,
    clock: () => now,
  });

  const listed = await rooms.create({
    actorId: 'listed-host',
    createRequestId: 'listing-listed',
    options: optionsFor(rooms, 'listed'),
  });
  const inviteOnly = await rooms.create({
    actorId: 'private-host',
    createRequestId: 'listing-private',
    options: optionsFor(rooms, 'private', { visibility: 'invite_only' }),
  });
  const starting = await rooms.create({
    actorId: 'starting-host',
    createRequestId: 'listing-starting',
    options: optionsFor(rooms, 'starting'),
  });
  const playing = await rooms.create({
    actorId: 'playing-host',
    createRequestId: 'listing-playing',
    options: optionsFor(rooms, 'playing', { allowPublicSpectators: true }),
  });
  const expired = await rooms.create({
    actorId: 'expired-host',
    createRequestId: 'listing-expired',
    options: optionsFor(rooms, 'expired'),
  });

  await repository.mutate(starting.room.code, (room) => {
    room.status = 'starting';
  });
  await repository.mutate(playing.room.code, (room) => {
    room.status = 'playing';
    room.lastActivityAt = 0;
  });
  const expiredIdentity = await rooms.identity(
    expired.room.code,
    'expired-host',
    expired.credentials.resumeToken,
  );
  await rooms.disconnect(expiredIdentity, 'expired-connection');
  now = 1_101;

  await repository.save({
    ...(await repository.get(listed.room.code))!,
    code: 'FOREIGN',
    id: 'foreign-id',
    environment: 'test',
    deploymentNamespace: 'other-namespace',
  });

  const visible = await rooms.listPublicRooms();
  assert.deepEqual(
    visible.map((room) => room.roomCode),
    [listed.room.code, playing.room.code],
  );

  const removed = await rooms.sweepExpiredRooms();
  assert.deepEqual(removed.map((entry) => entry.roomCode), [expired.room.code]);
  assert.equal(await repository.get(expired.room.code), undefined);
  assert.notEqual(await repository.get(playing.room.code), undefined);

  const publicJoin = await rooms.join({
    actorId: 'guest-without-token',
    name: 'Guest',
    roomCode: listed.room.code,
  });
  assert.equal(publicJoin.room.members.some((member) => member.id === 'guest-without-token'), true);
  await rooms.join({
    actorId: 'guest-with-token',
    name: 'Guest',
    roomCode: listed.room.code,
    joinToken: listed.credentials.joinToken,
  });

  await rooms.close();
  void inviteOnly;
});

test('terminal room retention removes its event stream', async () => {
  let now = 1_000;
  const repository = new InMemoryRoomRepository();
  const eventStore = new InMemoryEventStore();
  const rooms = new RoomService(repository, eventStore, {
    environment: 'test',
    deploymentNamespace: 'retention-test',
    endedRoomTtlMs: 10,
    roomSweepIntervalMs: 0,
    clock: () => now,
  });
  const ended = await rooms.create({
    actorId: 'ended-host',
    createRequestId: 'retention-ended',
    options: optionsFor(rooms, 'ended'),
  });
  await repository.mutate(ended.room.code, (room) => {
    room.status = 'ended';
    room.gameId = 'retention-game';
    room.closedAt = 0;
    room.lastActivityAt = 0;
  });
  await eventStore.append({
    streamId: 'game:retention-game',
    expectedVersion: 0,
    events: [{
      eventId: 'retention-event',
      roomId: ended.room.id,
      gameId: 'retention-game',
      sequence: 1,
      occurredAt: 1,
      phase: 'night',
      stage: 'guard_seer',
      eventType: 'game.state_updated',
      payload: {},
      visibility: 'public_timeline',
      correlationId: 'retention-event',
      schemaVersion: 1,
    }],
  });
  now = 11;

  assert.equal((await eventStore.read('game:retention-game')).length, 1);
  await rooms.sweepExpiredRooms();
  assert.equal(await repository.get(ended.room.code), undefined);
  assert.equal((await eventStore.read('game:retention-game')).length, 0);
  await rooms.close();
});

test('online waiting and playing rooms are never swept by waiting TTL', async () => {
  let now = 1_000;
  const repository = new InMemoryRoomRepository();
  const rooms = new RoomService(repository, new InMemoryEventStore(), {
    environment: 'test',
    deploymentNamespace: 'ttl-test',
    waitingRoomTtlMs: 10,
    endedRoomTtlMs: 10,
    roomSweepIntervalMs: 0,
    clock: () => now,
  });
  const online = await rooms.create({
    actorId: 'online-host',
    createRequestId: 'ttl-online',
    options: optionsFor(rooms, 'online'),
  });
  const playing = await rooms.create({
    actorId: 'playing-host',
    createRequestId: 'ttl-playing',
    options: optionsFor(rooms, 'playing', { allowPublicSpectators: true }),
  });
  await repository.mutate(playing.room.code, (room) => {
    room.status = 'playing';
    room.lastActivityAt = 0;
  });
  now = 100;
  assert.deepEqual(await rooms.sweepExpiredRooms(), []);
  assert.ok(await repository.get(online.room.code));
  assert.ok(await repository.get(playing.room.code));
  await rooms.close();
});
