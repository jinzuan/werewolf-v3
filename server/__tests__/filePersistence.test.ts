import assert from 'node:assert/strict';
import test from 'node:test';
import {
  atomicWriteFile,
  atomicWriteFileSync,
  type AsyncAtomicFileOperations,
  type SyncAtomicFileOperations,
} from '../filePersistence';

const errorWithCode = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code });

const asyncOperations = (
  overrides: Partial<AsyncAtomicFileOperations>,
): AsyncAtomicFileOperations => ({
  mkdir: async () => undefined,
  writeFile: async () => undefined,
  rename: async () => undefined,
  copyFile: async () => undefined,
  unlink: async () => undefined,
  ...overrides,
});

test('atomic write retries transient rename EPERM before succeeding', async () => {
  let renameAttempts = 0;
  let copied = false;
  const delays: number[] = [];

  const persisted = await atomicWriteFile('rooms.json', '[]', {
    operations: asyncOperations({
      rename: async () => {
        renameAttempts += 1;
        if (renameAttempts < 3) throw errorWithCode('EPERM');
      },
      copyFile: async () => {
        copied = true;
      },
    }),
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  assert.equal(persisted, true);
  assert.equal(renameAttempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(copied, false);
});

test('atomic write falls back to copy and temp deletion after EPERM retries', async () => {
  let renameAttempts = 0;
  let copiedFrom = '';
  let copiedTo = '';
  let deleted = '';
  const delays: number[] = [];

  const persisted = await atomicWriteFile('events.json', '{}', {
    operations: asyncOperations({
      rename: async () => {
        renameAttempts += 1;
        throw errorWithCode('EPERM');
      },
      copyFile: async (source, destination) => {
        copiedFrom = source;
        copiedTo = destination;
      },
      unlink: async (file) => {
        deleted = file;
      },
    }),
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  assert.equal(persisted, true);
  assert.equal(renameAttempts, 4);
  assert.deepEqual(delays, [10, 20, 30]);
  assert.match(copiedFrom, /^events\.json\..+\.tmp$/);
  assert.equal(copiedTo, 'events.json');
  assert.equal(deleted, copiedFrom);
});

test('atomic write logs and returns false when rename and copy both fail', async () => {
  const logs: Array<{ message: string; error: unknown }> = [];
  let cleanupAttempts = 0;

  const persisted = await atomicWriteFile('rooms.json', '[]', {
    operations: asyncOperations({
      rename: async () => {
        throw errorWithCode('EPERM');
      },
      copyFile: async () => {
        throw errorWithCode('EACCES');
      },
      unlink: async () => {
        cleanupAttempts += 1;
      },
    }),
    sleep: async () => undefined,
    logger: (message, error) => {
      logs.push({ message, error });
    },
  });

  assert.equal(persisted, false);
  assert.equal(cleanupAttempts, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /rooms\.json/);
  assert.equal((logs[0].error as NodeJS.ErrnoException).code, 'EACCES');
});

test('atomic write isolates serialization failures', async () => {
  const logs: Array<{ message: string; error: unknown }> = [];

  const persisted = await atomicWriteFile(
    'rooms.json',
    () => {
      throw new Error('SERIALIZE_FAILED');
    },
    {
      operations: asyncOperations({}),
      logger: (message, error) => {
        logs.push({ message, error });
      },
    },
  );

  assert.equal(persisted, false);
  assert.equal(logs.length, 1);
  assert.match((logs[0].error as Error).message, /SERIALIZE_FAILED/);
});

test('sync atomic write uses copy fallback after rename EPERM retries', () => {
  let renameAttempts = 0;
  let copied = false;
  let deleted = false;
  const operations: SyncAtomicFileOperations = {
    mkdir: () => undefined,
    writeFile: () => undefined,
    rename: () => {
      renameAttempts += 1;
      throw errorWithCode('EPERM');
    },
    copyFile: () => {
      copied = true;
    },
    unlink: () => {
      deleted = true;
    },
  };

  const persisted = atomicWriteFileSync('archives.json', '[]', {
    operations,
    sleep: () => undefined,
  });

  assert.equal(persisted, true);
  assert.equal(renameAttempts, 4);
  assert.equal(copied, true);
  assert.equal(deleted, true);
});
