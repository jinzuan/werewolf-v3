import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';

test('a 12 AI room advances without human commands to an ended game', async () => {
  const rooms = new RoomService(
    new InMemoryRoomRepository(),
    new InMemoryEventStore(),
    { aiTimeoutMs: 100 },
  );
  const created = await rooms.create({
    actorId: 'observer',
    options: {
      roomName: 'Auto game',
      maxPlayers: 12,
      aiCount: 12,
      name: 'Observer',
      spectator: true,
      auto: true,
    },
  });

  const deadline = Date.now() + 5_000;
  let record = await rooms.getRecord(created.room.code);
  while (record?.status !== 'ended' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    record = await rooms.getRecord(created.room.code);
  }
  assert.equal(record?.players.length, 12);
  assert.equal(record?.status, 'ended');
  assert.equal(record?.session?.state.gameState.phase, 'ended');
  assert.ok((record?.session?.state.gameState.day ?? 0) >= 1);
  await rooms.close();
});
