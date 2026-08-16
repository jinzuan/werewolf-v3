import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  atomicWriteFile,
  atomicWriteFileSync,
  withFileLock,
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
  sync: async () => undefined,
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

test('atomic write never copies over the destination after rename failure', async () => {
  let renameAttempts = 0;
  let copied = false;
  let deleted = '';
  const delays: number[] = [];

  await assert.rejects(() => atomicWriteFile('events.json', '{}', {
    operations: asyncOperations({
      rename: async () => {
        renameAttempts += 1;
        throw errorWithCode('EPERM');
      },
      copyFile: async () => {
        copied = true;
      },
      unlink: async (file) => {
        deleted = file;
      },
    }),
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  }));

  assert.equal(renameAttempts, 4);
  assert.deepEqual(delays, [10, 20, 30]);
  assert.equal(copied, false);
  assert.match(deleted, /^events\.json\..+\.tmp$/);
});

test('atomic write logs and rethrows when rename fails', async () => {
  const logs: Array<{ message: string; error: unknown }> = [];
  let cleanupAttempts = 0;

  await assert.rejects(() => atomicWriteFile('rooms.json', '[]', {
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
  }));

  assert.equal(cleanupAttempts, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /rooms\.json/);
  assert.equal((logs[0].error as NodeJS.ErrnoException).code, 'EPERM');
});

test('atomic write logs and rethrows serialization failures', async () => {
  const logs: Array<{ message: string; error: unknown }> = [];

  await assert.rejects(() => atomicWriteFile(
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
  ));

  assert.equal(logs.length, 1);
  assert.match((logs[0].error as Error).message, /SERIALIZE_FAILED/);
});

test('sync atomic write never copies after rename EPERM retries', () => {
  let renameAttempts = 0;
  let copied = false;
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
      // Best-effort temp cleanup.
    },
    sync: () => undefined,
  };

  assert.throws(() => atomicWriteFileSync('archives.json', '[]', {
    operations,
    sleep: () => undefined,
  }));

  assert.equal(renameAttempts, 4);
  assert.equal(copied, false);
});

test('atomic write fsyncs the temporary file and its parent directory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v3-fsync-'));
  const file = path.join(directory, 'rooms.json');
  const synced: string[] = [];
  try {
    await atomicWriteFile(file, '{"ok":true}', {
      dataRoot: directory,
      operations: {
        sync: async (target) => {
          synced.push(target);
          const handle = await open(target, 'r');
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        },
      },
    });
    assert.equal(synced.length, 2);
    assert.match(synced[0], /rooms\.json\..+\.tmp$/);
    assert.equal(synced[1], directory);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ok: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a SIGKILL during temporary-file writing leaves the last JSON complete', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v3-kill-write-'));
  const file = path.join(directory, 'rooms.json');
  const moduleUrl = pathToFileURL(path.resolve('server/filePersistence.ts')).href;
  await atomicWriteFile(file, JSON.stringify({ version: 1 }), { dataRoot: directory });
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e', `
      import { open } from 'node:fs/promises';
      import { atomicWriteFile } from ${JSON.stringify(moduleUrl)};
      void atomicWriteFile(${JSON.stringify(file)}, JSON.stringify({ version: 2, payload: 'x'.repeat(1000000) }), {
        dataRoot: ${JSON.stringify(directory)},
        operations: {
          writeFile: async (target, value) => {
            const handle = await open(target, 'w', 0o600);
            await handle.write(value.slice(0, 64), 0, 'utf8');
            await handle.sync();
            process.stdout.write('WRITING\\n');
            await new Promise(() => {});
          },
        },
      });
      setInterval(() => {}, 1000);
    `,
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout?.once('data', (chunk) => {
        if (String(chunk).includes('WRITING')) resolve();
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`writer exited before signal: ${code}`)));
    });
    child.kill('SIGKILL');
    await once(child, 'exit');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1 });
  } finally {
    child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test('a SIGKILL leaves a lease lock that the next process can recover', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v3-kill-lock-'));
  const file = path.join(directory, 'rooms.json');
  const moduleUrl = pathToFileURL(path.resolve('server/filePersistence.ts')).href;
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e', `
      import { withFileLock } from ${JSON.stringify(moduleUrl)};
      void withFileLock(${JSON.stringify(file)}, async () => {
        process.stdout.write('LOCKED\\n');
        await new Promise(() => {});
      });
      setInterval(() => {}, 1000);
    `,
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout?.once('data', (chunk) => {
        if (String(chunk).includes('LOCKED')) resolve();
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`locker exited before signal: ${code}`)));
    });
    child.kill('SIGKILL');
    await once(child, 'exit');
    assert.equal(
      await withFileLock(file, async () => 'recovered', {
        retryDelayMs: 5,
        maxAttempts: 100,
      }),
      'recovered',
    );
  } finally {
    child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});
