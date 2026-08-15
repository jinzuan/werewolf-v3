import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';
import type { RoomRecord } from '../rooms/types';

const startingRoom = (): RoomRecord => ({
  id: 'starting-room',
  code: 'STARTING',
  name: 'crashed start',
  joinToken: 'join',
  omniscientToken: 'omniscient',
  hostId: 'host',
  maxPlayers: 4,
  status: 'starting',
  auto: false,
  debugMode: false,
  configLocked: true,
  roomRevision: 1,
  configRevision: 1,
  config: {
    mode: 'mixed',
    visibility: 'invite_only',
    maxPlayers: 4,
    minHumanPlayers: 1,
    aiFillPolicy: 'fixed',
    computerSeats: 1,
    roleSetup: { wolf: 1, seer: 1, witch: 0, hunter: 0, guardian: 0, villager: 2 },
    rulesetId: 'werewolf.v3.default-12p',
    rulesetVersion: '3.0.0-stage1',
    catalogVersion: 'v3.1',
    readyPolicy: 'all_connected_humans',
    allowPublicSpectators: false,
  },
  members: [
    {
      id: 'host', name: 'Host', kind: 'player', connected: true,
      omniscient: false, resumeToken: 'resume', seatIndex: 0,
      isAI: false, ready: true, avatarId: 'avatar-player',
    },
    {
      id: 'ai:starting-room:1', name: '电脑 02', kind: 'player', connected: true,
      omniscient: false, resumeToken: '', seatIndex: 1,
      isAI: true, ready: null, avatarId: 'avatar-ai',
    },
  ],
  players: [],
  startOwner: 'host',
  startLeaseUntil: 0,
  startedAt: 1,
  startAddedAIIds: ['ai:starting-room:1'],
  createdAt: 1,
  updatedAt: 1,
});

test('restore rolls back an expired uncommitted starting claim', async () => {
  const repository = new InMemoryRoomRepository([startingRoom()]);
  const rooms = new RoomService(repository, new InMemoryEventStore());
  await rooms.restore();
  const recovered = await repository.get('STARTING');
  assert.equal(recovered?.status, 'ready_check');
  assert.equal(recovered?.members.some((member) => member.isAI), false);
  assert.equal(recovered?.startLeaseUntil, undefined);
  await rooms.close();
});
