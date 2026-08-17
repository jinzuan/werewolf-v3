import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PENDING_CREATE_TTL_MS,
  clearPendingCreate,
  readPendingCreate,
  writePendingCreate,
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
