import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DOMAIN_EVENT_SCHEMA_VERSION, type DomainEvent } from '../../shared/events';
import { FileEventStore } from '../events/fileStore';
import { FileRoomRepository } from '../rooms/fileRepository';
import type { RoomRecord } from '../rooms/types';

const room = (code: string): RoomRecord => ({
  id: `id-${code}`,
  code,
  name: code,
  joinToken: `join-${code}`,
  omniscientToken: `omniscient-${code}`,
  hostId: `host-${code}`,
  maxPlayers: 1,
  status: 'waiting',
  auto: false,
  debugMode: false,
  members: [],
  players: [],
  createdAt: 1,
});

const event = (sequence: number): DomainEvent => ({
  eventId: `event-${sequence}`,
  roomId: 'room-1',
  gameId: 'game-1',
  sequence,
  occurredAt: sequence,
  phase: 'night',
  stage: 'guard_seer',
  eventType: 'game.state_updated',
  payload: {},
  visibility: 'public_timeline',
  correlationId: `correlation-${sequence}`,
  schemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
});

test('production and E2E roots remain physically isolated and namespace-bound', async () => {
  const productionDir = await mkdtemp(path.join(os.tmpdir(), 'ww-prod-'));
  const e2eDir = await mkdtemp(path.join(os.tmpdir(), 'ww-e2e-'));
  try {
    const production = new FileRoomRepository(path.join(productionDir, 'rooms.json'), {
      environment: 'production',
      deploymentNamespace: 'prod',
    });
    const e2e = new FileRoomRepository(path.join(e2eDir, 'rooms.json'), {
      environment: 'test',
      deploymentNamespace: 'e2e',
    });
    await e2e.save(room('E2E01'));
    assert.deepEqual(await production.list(), []);
    assert.equal((await e2e.list())[0].deploymentNamespace, 'e2e');
    assert.match(await readFile(path.join(e2eDir, 'rooms.json'), 'utf8'), /"deploymentNamespace": "e2e"/);
    await assert.rejects(
      new FileRoomRepository(path.join(e2eDir, 'rooms.json'), {
        environment: 'test',
        deploymentNamespace: 'wrong',
      }).list(),
      (error: unknown) => (error as { code?: string }).code === 'DATA_NAMESPACE_MISMATCH',
    );

    const productionEvents = new FileEventStore(path.join(productionDir, 'events.json'), {
      environment: 'production',
      deploymentNamespace: 'prod',
    });
    const e2eEvents = new FileEventStore(path.join(e2eDir, 'events.json'), {
      environment: 'test',
      deploymentNamespace: 'e2e',
    });
    await e2eEvents.append({ streamId: 'game:game-1', expectedVersion: 0, events: [event(1)] });
    assert.deepEqual(await productionEvents.read('game:game-1'), []);
    await assert.rejects(
      new FileEventStore(path.join(e2eDir, 'events.json'), {
        environment: 'test',
        deploymentNamespace: 'wrong',
      }).read('game:game-1'),
      /another deployment namespace/,
    );
  } finally {
    await rm(productionDir, { recursive: true, force: true });
    await rm(e2eDir, { recursive: true, force: true });
}
});

test('a repository observes an external controlled write on its next read', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ww-revision-'));
  const file = path.join(directory, 'rooms.json');
  try {
    const first = new FileRoomRepository(file, { environment: 'test', deploymentNamespace: 'same' });
    const second = new FileRoomRepository(file, { environment: 'test', deploymentNamespace: 'same' });
    await first.save(room('ONE001'));
    assert.deepEqual((await first.list()).map((item) => item.code), ['ONE001']);
    await second.save(room('TWO002'));
    assert.deepEqual((await first.list()).map((item) => item.code).sort(), ['ONE001', 'TWO002']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
