import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';

const optionsFor = (rooms: RoomService, roomName: string) => {
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
  };
};

test('public room listing clamps page size and resumes from a stable cursor', async () => {
  const rooms = new RoomService(
    new InMemoryRoomRepository(),
    new InMemoryEventStore(),
    { environment: 'test', deploymentNamespace: 'pagination-test', roomSweepIntervalMs: 0 },
  );
  for (let index = 0; index < 105; index += 1) {
    await rooms.create({
      actorId: `host-${index}`,
      options: optionsFor(rooms, `listed-${index}`),
    });
  }

  const first = await rooms.listPublicRooms({ limit: 2 });
  assert.equal(first.rooms.length, 2);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);

  const second = await rooms.listPublicRooms({ cursor: first.nextCursor!, limit: 2 });
  assert.equal(second.rooms.length, 2);
  assert.equal(
    second.rooms.some((room) => first.rooms.some((item) => item.roomCode === room.roomCode)),
    false,
  );

  const bounded = await rooms.listPublicRooms({ limit: 10_000 });
  assert.equal(bounded.rooms.length, 100);
  assert.equal(bounded.hasMore, true);
  await rooms.close();
});
