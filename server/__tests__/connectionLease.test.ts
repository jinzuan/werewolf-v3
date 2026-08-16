import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';
import { createRequest } from './fixtures';

test('two sockets for one resume identity keep the member online until the last lease closes', async () => {
  const rooms = new RoomService(new InMemoryRoomRepository(), new InMemoryEventStore());
  const created = await rooms.create({
    ...createRequest(rooms, 'host', 'lease-create', 'lease room'),
  });
  const identity = await rooms.identity(
    created.room.code,
    'host',
    created.credentials.resumeToken,
  );

  await rooms.bindConnection(identity, 'socket-a');
  await rooms.bindConnection(identity, 'socket-b');
  await rooms.disconnect(identity, 'socket-a');
  assert.equal((await rooms.getRecord(created.room.code))?.members[0].connected, true);
  await rooms.disconnect(identity, 'socket-b');
  assert.equal((await rooms.getRecord(created.room.code))?.members[0].connected, false);
  await rooms.close();
});
