import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionPersistenceWriter } from '../../runtime/sessionPersistence';
import type { V3Session } from '../session';

class MemoryStorage implements Pick<Storage, 'setItem' | 'removeItem'> {
  values = new Map<string, string>();
  writes = 0;

  setItem(key: string, value: string): void {
    this.writes += 1;
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.writes += 1;
    this.values.delete(key);
  }
}

class LifecycleTarget extends EventTarget {
  emit(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}

const session = (lastSeenSeq: number, resumeToken = 'resume-1'): V3Session => ({
  version: 2,
  actorId: 'actor-1',
  actorName: '玩家',
  roomCode: 'ABC123',
  roomId: 'room-1',
  credentials: { resumeToken, joinToken: 'join-1' },
  mode: 'player',
  gameId: 'game-1',
  lastSeenSeq,
});

test('coalesces event cursors and flushes on lifecycle events', () => {
  const storage = new MemoryStorage();
  const lifecycle = new LifecycleTarget();
  let scheduled: (() => void) | null = null;
  const writer = new SessionPersistenceWriter({
    storage,
    eventTarget: lifecycle,
    setTimeout: (handler) => {
      scheduled = handler;
      return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimeout: () => {
      scheduled = null;
    },
  }).start();

  writer.persistIdentity(session(0));
  for (let sequence = 1; sequence <= 100; sequence += 1) {
    writer.scheduleCursor(session(sequence));
  }
  assert.equal(storage.writes, 1);
  assert.ok(scheduled);

  lifecycle.emit('visibilitychange');
  assert.equal(storage.writes, 2);
  assert.equal(JSON.parse(storage.values.get('werewolf-v3-session')!).lastSeenSeq, 100);
  assert.equal(writer.getStats().writeCount, 2);

  writer.scheduleCursor(session(101));
  lifecycle.emit('pagehide');
  assert.equal(JSON.parse(storage.values.get('werewolf-v3-session')!).lastSeenSeq, 101);
  writer.dispose();
});

test('identity changes bypass the cursor window and oversized sessions stay out of storage', () => {
  const storage = new MemoryStorage();
  const writer = new SessionPersistenceWriter({
    storage,
    eventTarget: null,
    maxSerializedBytes: 256,
  });

  writer.persistIdentity(session(0));
  assert.equal(storage.writes, 1);
  writer.scheduleCursor(session(1));
  writer.persistIdentity(session(2, 'rotated-resume'));
  assert.equal(storage.writes, 2);
  assert.equal(JSON.parse(storage.values.get('werewolf-v3-session')!).credentials.resumeToken, 'rotated-resume');

  writer.persistIdentity({ ...session(2), actorName: 'x'.repeat(1_000) });
  assert.equal(storage.writes, 2);
  assert.equal(writer.getStats().lastError, 'V3_SESSION_TOO_LARGE');
});
