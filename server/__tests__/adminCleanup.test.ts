import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { FileRoomRepository } from '../rooms/fileRepository';
import type { RoomRecord } from '../rooms/types';

const execFileAsync = promisify(execFile);

const expiredRoom = (): RoomRecord => ({
  id: 'expired-id',
  code: 'EXPIRED',
  name: 'Expired',
  joinToken: 'never-output',
  omniscientToken: 'never-output',
  hostId: 'host',
  maxPlayers: 1,
  status: 'waiting',
  auto: false,
  debugMode: false,
  members: [],
  players: [],
  environment: 'test',
  deploymentNamespace: 'admin-test',
  createdAt: 0,
  lastActivityAt: 0,
});

const runAdmin = async (directory: string, ...command: string[]) => {
  const result = await execFileAsync(
    path.resolve('node_modules/.bin/tsx'),
    ['scripts/admin/rooms.ts', ...command, '--data-dir', directory, '--namespace', 'admin-test'],
    {
      cwd: path.resolve('.'),
      env: { ...process.env, WW_ENV: 'test', WW_WAITING_ROOM_TTL_MS: '0' },
    },
  );
  return JSON.parse(result.stdout.trim()) as unknown;
};

test('admin cleanup uses repository locking and emits no room credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ww-admin-'));
  try {
    const repository = new FileRoomRepository(path.join(directory, 'rooms.json'), {
      environment: 'test',
      deploymentNamespace: 'admin-test',
    });
    await repository.save(expiredRoom());
    const listed = await runAdmin(directory, 'list-expired');
    assert.deepEqual(listed, [{
      roomCode: 'EXPIRED',
      status: 'waiting',
      reason: 'offline_waiting_room_ttl',
      lastActivityAt: 0,
    }]);
    assert.doesNotMatch(JSON.stringify(listed), /never-output|token|secret/i);
    const swept = await runAdmin(directory, 'sweep');
    assert.deepEqual(swept, [{ roomCode: 'EXPIRED', reason: 'offline_waiting_room_ttl', lastActivityAt: 0 }]);
    assert.equal(await repository.get('EXPIRED'), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
}
});
