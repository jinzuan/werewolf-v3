import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PENDING_CREATE_TTL_MS,
  clearPendingCreate,
  readPendingCreate,
  writePendingCreate,
} from '../../stores/v3/authorityStore';
import {
  PENDING_JOIN_TTL_MS,
  clearPendingJoin,
  readPendingJoin,
  writePendingJoin,
} from '../../stores/v3/authorityStore';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const withSessionStorage = async (run: (storage: MemoryStorage) => void): Promise<void> => {
  const previous = (globalThis as { sessionStorage?: unknown }).sessionStorage;
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: storage,
  });
  try {
    run(storage);
  } finally {
    if (previous === undefined) delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    else Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: previous });
  }
};

test('pending room creation expires and is regenerated instead of replaying stale state', async () => {
  await withSessionStorage((storage) => {
    const createdAt = 10_000;
    writePendingCreate({ createRequestId: 'request-1', actorId: 'actor-1', createdAt });
    assert.deepEqual(readPendingCreate(createdAt + PENDING_CREATE_TTL_MS - 1), {
      createRequestId: 'request-1',
      actorId: 'actor-1',
      createdAt,
    });
    assert.equal(readPendingCreate(createdAt + PENDING_CREATE_TTL_MS), null);
    assert.equal(storage.getItem('werewolf-v3-pending-create'), null);
  });
});

test('legacy and malformed pending create records are cleared', async () => {
  await withSessionStorage((storage) => {
    storage.setItem('werewolf-v3-pending-create', JSON.stringify({
      createRequestId: 'old-request',
      actorId: 'old-actor',
    }));
    assert.equal(readPendingCreate(20_000), null);
    assert.equal(storage.getItem('werewolf-v3-pending-create'), null);

    storage.setItem('werewolf-v3-pending-create', '{broken');
    assert.equal(readPendingCreate(20_000), null);
    clearPendingCreate();
    assert.equal(storage.getItem('werewolf-v3-pending-create'), null);
  });
});

test('pending joins preserve one actor/request across ACK retry and clear safely', async () => {
  await withSessionStorage((storage) => {
    const pending = {
      joinRequestId: 'join-request-1',
      actorId: 'join-actor-1',
      roomCode: 'ABC123',
      actorName: '玩家',
      mode: 'player' as const,
      createdAt: 10_000,
    };
    writePendingJoin(pending);
    assert.deepEqual(readPendingJoin(10_000 + PENDING_JOIN_TTL_MS - 1), pending);
    clearPendingJoin('other-request');
    assert.notEqual(storage.getItem('werewolf-v3-pending-join'), null);
    clearPendingJoin(pending.joinRequestId);
    assert.equal(storage.getItem('werewolf-v3-pending-join'), null);
  });
});

test('malformed and expired pending joins are removed', async () => {
  await withSessionStorage((storage) => {
    storage.setItem('werewolf-v3-pending-join', JSON.stringify({ actorId: 'old' }));
    assert.equal(readPendingJoin(20_000), null);
    assert.equal(storage.getItem('werewolf-v3-pending-join'), null);
    writePendingJoin({
      joinRequestId: 'expired',
      actorId: 'actor',
      roomCode: 'ABC123',
      actorName: '玩家',
      mode: 'spectator',
      createdAt: 10_000,
    });
    assert.equal(readPendingJoin(10_000 + PENDING_JOIN_TTL_MS), null);
    assert.equal(storage.getItem('werewolf-v3-pending-join'), null);
  });
});
