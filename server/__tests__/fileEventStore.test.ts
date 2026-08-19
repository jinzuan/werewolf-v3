import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DOMAIN_EVENT_SCHEMA_VERSION,
  type DomainEvent,
} from '../../shared/events';
import { FileEventStore } from '../events/fileStore';
import { EventVersionConflictError } from '../events/store';

const errorWithCode = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code });

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

test('file event store rejects failed persistence and does not advance the stream', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v3-events-'));
  const filePath = path.join(directory, 'events.json');
  const logs: Array<{ message: string; error: unknown }> = [];
  const streamId = 'game:game-1';

  try {
    await new FileEventStore(filePath).append({
      streamId,
      expectedVersion: 0,
      events: [event(1)],
    });

    const store = new FileEventStore(filePath, {
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
    await assert.rejects(() => store.append({
      streamId,
      expectedVersion: 1,
      events: [event(2)],
    }), /EACCES|EPERM/);

    assert.deepEqual(
      (await store.read(streamId)).map(({ event: item }) => item.eventId),
      ['event-1'],
    );
    await assert.rejects(
      store.append({
        streamId,
        expectedVersion: 0,
        events: [event(3)],
      }),
      EventVersionConflictError,
    );
    assert.equal(logs.length, 1);

    const restarted = new FileEventStore(filePath);
    assert.deepEqual(
      (await restarted.read(streamId)).map(({ event: item }) => item.eventId),
      ['event-1'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file event store removes a terminal stream during retention cleanup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v3-events-retention-'));
  const filePath = path.join(directory, 'events.json');
  try {
    const store = new FileEventStore(filePath);
    await store.append({ streamId: 'game:ended', expectedVersion: 0, events: [event(1)] });
    await store.remove('game:ended');
    assert.deepEqual(await store.read('game:ended'), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
