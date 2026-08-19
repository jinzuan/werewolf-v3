import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';
import { createRequest } from './fixtures';

test('public listed rooms accept a player without forcing an invite token', async () => {
  const rooms = new RoomService(new InMemoryRoomRepository(), new InMemoryEventStore());
  const created = await rooms.create({
    ...createRequest(rooms, 'host', 'public-join', '公开房', {
      visibility: 'listed',
      allowPublicSpectators: true,
    }),
  });

  const joined = await rooms.join({
    actorId: 'public-player',
    name: '大厅玩家',
    roomCode: created.room.code,
  });
  assert.equal(joined.room.members.some((member) => member.id === 'public-player'), true);
  await rooms.close();
});

test('waiting-room seat actions replace AI, preserve spectators, and expose host requests', async () => {
  const rooms = new RoomService(new InMemoryRoomRepository(), new InMemoryEventStore());
  const created = await rooms.create({
    ...createRequest(rooms, 'host', 'seat-actions', '席位交互', {
      allowPublicSpectators: true,
      visibility: 'listed',
    }),
  });
  const host = await rooms.identity(created.room.code, 'host', created.credentials.resumeToken);
  const guest = await rooms.join({
    actorId: 'guest',
    name: '玩家甲',
    roomCode: created.room.code,
  });
  const spectator = await rooms.join({
    actorId: 'spectator',
    name: '观战者',
    roomCode: created.room.code,
    spectator: true,
  });
  const spectatorIdentity = await rooms.identity(
    created.room.code,
    'spectator',
    spectator.credentials.resumeToken,
  );

  const withAI = await rooms.addAISeat(host, undefined, spectator.room.roomRevision, 'add-seat-ai');
  const aiSeat = withAI.members.find((member) => member.isAI)?.seatIndex;
  assert.equal(typeof aiSeat, 'number');
  const replaced = await rooms.claimSeat(spectatorIdentity, aiSeat, withAI.roomRevision, 'claim-ai-seat');
  assert.equal(replaced.members.find((member) => member.id === 'spectator')?.kind, 'player');
  assert.equal(replaced.members.some((member) => member.seatIndex === aiSeat && member.isAI), false);

  const guestIdentity = await rooms.identity(
    created.room.code,
    'guest',
    guest.credentials.resumeToken,
  );
  const watching = await rooms.becomeSpectator(
    guestIdentity,
    replaced.roomRevision,
    'guest-watch',
  );
  assert.equal(watching.members.find((member) => member.id === 'guest')?.kind, 'spectator');
  const watchingIdentity = await rooms.identity(
    created.room.code,
    'guest',
    guest.credentials.resumeToken,
  );
  const requested = await rooms.requestSeat(watchingIdentity, watching.roomRevision, 'guest-request');
  assert.equal(requested.seatRequests?.[0]?.status, 'pending');
  const hostView = await rooms.respondSeatRequest(
    host,
    requested.seatRequests![0]!.id,
    true,
    requested.roomRevision,
    'host-approve-request',
  );
  assert.equal(hostView.seatRequests?.[0]?.status, 'approved');

  const kicked = await rooms.kickPlayer(
    host,
    'spectator',
    hostView.roomRevision,
    'host-kick-player',
  );
  assert.equal(kicked.members.some((member) => member.id === 'spectator'), false);
  await rooms.close();
});
