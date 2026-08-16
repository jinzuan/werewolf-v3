import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileRoomRepository } from '../rooms/fileRepository';
import type { RoomRecord } from '../rooms/types';

const errorWithCode = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code });

const roomRecord = (index: number): RoomRecord => ({
  id: `room-${index}`,
  code: `ROOM${index.toString().padStart(2, '0')}`,
  name: `Room ${index}`,
  joinToken: `join-${index}`,
  omniscientToken: `omniscient-${index}`,
  hostId: `host-${index}`,
  maxPlayers: 12,
  status: 'waiting',
  auto: false,
  debugMode: false,
  members: [],
  players: [],
  createdAt: index,
});

test('file room repository serializes concurrent saves without losing rooms', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v3-rooms-'));
  const repository = new FileRoomRepository(
    path.join(directory, 'rooms.json'),
  );
  const rooms = Array.from({ length: 24 }, (_, index) => roomRecord(index));

  try {
    await Promise.all(rooms.map((room) => repository.save(room)));
    const saved = await repository.list();

    assert.equal(saved.length, rooms.length);
    assert.deepEqual(
      saved.map((room) => room.code).sort(),
      rooms.map((room) => room.code).sort(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file room repository rejects failed persistence and restart sees last disk state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v3-rooms-'));
  const filePath = path.join(directory, 'rooms.json');
  const baseline = roomRecord(1);
  const unsaved = roomRecord(2);
  const logs: Array<{ message: string; error: unknown }> = [];

  try {
    await new FileRoomRepository(filePath).save(baseline);

    const repository = new FileRoomRepository(filePath, {
      operations: {
        rename: async () => {
          throw errorWithCode('EPERM');
        },
        copyFile: async () => {
          throw errorWithCode('EACCES');
        },
      },
      sleep: async () => undefined,
      logger: (message, error) => {
        logs.push({ message, error });
      },
    });

    await assert.rejects(() => repository.save(unsaved), /EACCES|EPERM/);

    assert.deepEqual(
      (await repository.list()).map((room) => room.code).sort(),
      [baseline.code],
    );
    assert.equal(logs.length, 1);

    const restarted = new FileRoomRepository(filePath);
    assert.deepEqual(
      (await restarted.list()).map((room) => room.code),
      [baseline.code],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
