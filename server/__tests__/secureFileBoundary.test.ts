import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertSecurePath,
  atomicWriteFile,
  DEFAULT_MAX_PERSISTED_FILE_BYTES,
  readSecureFile,
  SecureFileBoundaryError,
} from '../filePersistence';

const temporaryRoot = async (): Promise<string> =>
  mkdtemp(path.join(os.tmpdir(), 'ww-secure-boundary-'));

test('atomic persistence repairs the data root and writes 0600 regardless of umask', async () => {
  const root = await temporaryRoot();
  const previousUmask = process.umask(0o022);
  try {
    await chmod(root, 0o755);
    const file = path.join(root, 'rooms.json');
    assert.equal(await atomicWriteFile(file, 'canary', { dataRoot: root }), true);
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    assert.equal(await readFile(file, 'utf8'), 'canary');
  } finally {
    process.umask(previousUmask);
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy broad file permissions are narrowed before reading', async () => {
  const root = await temporaryRoot();
  try {
    const file = path.join(root, 'events.json');
    await writeFile(file, '[]', { mode: 0o644 });
    assert.equal(await readSecureFile(file, { dataRoot: root }), '[]');
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('symlinks, non-regular files, data-root escapes, and oversized files fail closed', async () => {
  const root = await temporaryRoot();
  const outside = await temporaryRoot();
  try {
    const target = path.join(root, 'reviews.json');
    await writeFile(target, 'secret', { mode: 0o600 });
    const link = path.join(root, 'insights.json');
    await symlink(target, link);

    await assert.rejects(
      () => readSecureFile(link, { dataRoot: root }),
      (error: unknown) => error instanceof SecureFileBoundaryError && error.code === 'FILE_SYMLINK_NOT_ALLOWED',
    );
    await assert.rejects(
      () => readSecureFile(root, { dataRoot: root }),
      (error: unknown) => error instanceof SecureFileBoundaryError,
    );
    assert.throws(
      () => assertSecurePath(path.join(outside, 'escape.json'), root),
      (error: unknown) => error instanceof SecureFileBoundaryError && error.code === 'FILE_PATH_OUTSIDE_DATA_ROOT',
    );

    const oversized = path.join(root, 'credentials.json');
    await writeFile(oversized, 'x'.repeat(DEFAULT_MAX_PERSISTED_FILE_BYTES + 1), { mode: 0o600 });
    await assert.rejects(
      () => readSecureFile(oversized, { dataRoot: root }),
      (error: unknown) => error instanceof SecureFileBoundaryError && error.code === 'FILE_TOO_LARGE',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
