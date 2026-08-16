import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile as writeFilePromise,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Stats } from 'node:fs';

export const SECURE_DIRECTORY_MODE = 0o700;
export const SECURE_FILE_MODE = 0o600;
export const DEFAULT_MAX_PERSISTED_FILE_BYTES = 8 * 1024 * 1024;

export type SecureFileBoundaryErrorCode =
  | 'INVALID_DATA_ROOT'
  | 'INVALID_FILE_PATH'
  | 'FILE_PATH_OUTSIDE_DATA_ROOT'
  | 'FILE_SYMLINK_NOT_ALLOWED'
  | 'FILE_NOT_REGULAR'
  | 'DIRECTORY_NOT_SECURE'
  | 'FILE_OWNER_MISMATCH'
  | 'FILE_PERMISSION_REPAIR_FAILED'
  | 'DIRECTORY_PERMISSION_REPAIR_FAILED'
  | 'FILE_TOO_LARGE';

export class SecureFileBoundaryError extends Error {
  constructor(
    public readonly code: SecureFileBoundaryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SecureFileBoundaryError';
  }
}

export interface AsyncAtomicFileOperations {
  mkdir(directory: string, options: { recursive: true }): Promise<unknown>;
  writeFile(file: string, value: string, encoding: 'utf8'): Promise<unknown>;
  rename(source: string, destination: string): Promise<unknown>;
  /** Retained for source compatibility; atomic writes never call this. */
  copyFile?(source: string, destination: string): Promise<unknown>;
  unlink(file: string): Promise<unknown>;
  sync(file: string): Promise<unknown>;
}

export interface SyncAtomicFileOperations {
  mkdir(directory: string, options: { recursive: true }): unknown;
  writeFile(file: string, value: string, encoding: 'utf8'): unknown;
  rename(source: string, destination: string): unknown;
  /** Retained for source compatibility; atomic writes never call this. */
  copyFile?(source: string, destination: string): unknown;
  unlink(file: string): unknown;
  sync(file: string): unknown;
}

type PersistenceLogger = (message: string, error: unknown) => void;
type PersistenceValue = string | (() => string);

export interface AsyncAtomicWriteOptions {
  operations?: Partial<AsyncAtomicFileOperations>;
  sleep?: (delayMs: number) => Promise<void>;
  logger?: PersistenceLogger;
  /** The only directory in which this persistence target may live. */
  dataRoot?: string;
  /** Maximum encoded byte length accepted when reading this target. */
  maxBytes?: number;
}

export interface SyncAtomicWriteOptions {
  operations?: Partial<SyncAtomicFileOperations>;
  sleep?: (delayMs: number) => void;
  logger?: PersistenceLogger;
  dataRoot?: string;
  maxBytes?: number;
}

export interface FileLockOptions {
  retryDelayMs?: number;
  maxAttempts?: number;
  /** Lease duration. A dead local owner can be recovered immediately. */
  leaseMs?: number;
  /** Age after which an owner that cannot be checked is considered stale. */
  staleLockMs?: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
}

const RENAME_ATTEMPTS = 4;
const RETRY_DELAY_MS = 10;
const DEFAULT_LOCK_LEASE_MS = 30_000;
const DEFAULT_STALE_LOCK_MS = DEFAULT_LOCK_LEASE_MS;

const secureAsyncWriteFile = (
  file: string,
  value: string,
  _encoding: 'utf8',
): Promise<unknown> =>
  writeFilePromise(file, value, {
    encoding: 'utf8',
    flag: 'wx',
    mode: SECURE_FILE_MODE,
  });

const secureSyncWriteFile = (
  file: string,
  value: string,
  _encoding: 'utf8',
): unknown =>
  writeFileSync(file, value, {
    encoding: 'utf8',
    flag: 'wx',
    mode: SECURE_FILE_MODE,
  });

const defaultAsyncOperations: AsyncAtomicFileOperations = {
  mkdir,
  writeFile: secureAsyncWriteFile,
  rename,
  unlink,
  sync: async (file: string) => {
    const handle = await open(file, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

const defaultSyncOperations: SyncAtomicFileOperations = {
  mkdir: mkdirSync,
  writeFile: secureSyncWriteFile,
  rename: renameSync,
  unlink: unlinkSync,
  sync: (file: string) => {
    const descriptor = openSync(file, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  },
};

const defaultLogger: PersistenceLogger = (message, error) => {
  console.error(message, error);
};

const asyncSleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  (error as NodeJS.ErrnoException).code === 'ENOENT';

const currentUid = (): number | undefined =>
  typeof process.getuid === 'function' ? process.getuid() : undefined;

const modeOf = (details: Stats): number => details.mode & 0o777;

const validateMaxBytes = (maxBytes: number): void => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new SecureFileBoundaryError(
      'FILE_TOO_LARGE',
      'Persistence file byte limit is invalid.',
    );
  }
};

const dataRootOf = (file: string, dataRoot?: string): string => {
  if (!path.isAbsolute(file)) {
    throw new SecureFileBoundaryError(
      'INVALID_FILE_PATH',
      'Persistence file path must be absolute.',
    );
  }
  const root = path.resolve(dataRoot ?? path.dirname(file));
  if (!path.isAbsolute(root) || root === path.parse(root).root) {
    throw new SecureFileBoundaryError(
      'INVALID_DATA_ROOT',
      'Persistence data root must be an absolute, non-root directory.',
    );
  }
  return root;
};

/** Validate the lexical boundary before touching the filesystem. */
export const assertSecurePath = (file: string, dataRoot?: string): string => {
  const root = dataRootOf(file, dataRoot);
  const resolvedFile = path.resolve(file);
  const relative = path.relative(root, resolvedFile);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SecureFileBoundaryError(
      'FILE_PATH_OUTSIDE_DATA_ROOT',
      'Persistence file is outside its data root.',
    );
  }
  return root;
};

const ownerIsCurrent = (details: Stats): boolean => {
  const uid = currentUid();
  return uid === undefined || details.uid === uid;
};

const ensureOwner = (details: Stats): void => {
  if (!ownerIsCurrent(details)) {
    throw new SecureFileBoundaryError(
      'FILE_OWNER_MISMATCH',
      'Persistence path is owned by another user.',
    );
  }
};

const secureDirectoryStatus = async (directory: string): Promise<Stats> => {
  const details = await lstat(directory);
  if (details.isSymbolicLink()) {
    throw new SecureFileBoundaryError(
      'FILE_SYMLINK_NOT_ALLOWED',
      'Persistence directory symlinks are not allowed.',
    );
  }
  if (!details.isDirectory()) {
    throw new SecureFileBoundaryError(
      'DIRECTORY_NOT_SECURE',
      'Persistence path is not a directory.',
    );
  }
  ensureOwner(details);
  if (modeOf(details) !== SECURE_DIRECTORY_MODE) {
    try {
      await chmod(directory, SECURE_DIRECTORY_MODE);
    } catch {
      throw new SecureFileBoundaryError(
        'DIRECTORY_PERMISSION_REPAIR_FAILED',
        'Persistence directory permissions could not be restricted.',
      );
    }
    const repaired = await lstat(directory);
    if (
      repaired.isSymbolicLink() ||
      !repaired.isDirectory() ||
      modeOf(repaired) !== SECURE_DIRECTORY_MODE
    ) {
      throw new SecureFileBoundaryError(
        'DIRECTORY_PERMISSION_REPAIR_FAILED',
        'Persistence directory permissions could not be verified.',
      );
    }
    ensureOwner(repaired);
    return repaired;
  }
  return details;
};

const secureDirectoryStatusSync = (directory: string): Stats => {
  const details = lstatSync(directory);
  if (details.isSymbolicLink()) {
    throw new SecureFileBoundaryError(
      'FILE_SYMLINK_NOT_ALLOWED',
      'Persistence directory symlinks are not allowed.',
    );
  }
  if (!details.isDirectory()) {
    throw new SecureFileBoundaryError(
      'DIRECTORY_NOT_SECURE',
      'Persistence path is not a directory.',
    );
  }
  ensureOwner(details);
  if (modeOf(details) !== SECURE_DIRECTORY_MODE) {
    try {
      chmodSync(directory, SECURE_DIRECTORY_MODE);
    } catch {
      throw new SecureFileBoundaryError(
        'DIRECTORY_PERMISSION_REPAIR_FAILED',
        'Persistence directory permissions could not be restricted.',
      );
    }
    const repaired = lstatSync(directory);
    if (
      repaired.isSymbolicLink() ||
      !repaired.isDirectory() ||
      modeOf(repaired) !== SECURE_DIRECTORY_MODE
    ) {
      throw new SecureFileBoundaryError(
        'DIRECTORY_PERMISSION_REPAIR_FAILED',
        'Persistence directory permissions could not be verified.',
      );
    }
    ensureOwner(repaired);
    return repaired;
  }
  return details;
};

const secureDirectoryParts = (root: string, directory: string): string[] => {
  const relative = path.relative(root, directory);
  if (!relative) return [root];
  return [
    root,
    ...relative.split(path.sep).map((part, index, parts) =>
      path.join(root, ...parts.slice(0, index + 1))),
  ];
};

export const ensureSecureDirectory = async (
  directory: string,
  options: { dataRoot?: string } = {},
): Promise<void> => {
  const root = dataRootOf(path.join(directory, 'placeholder'), options.dataRoot ?? directory);
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(root, resolvedDirectory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SecureFileBoundaryError(
      'FILE_PATH_OUTSIDE_DATA_ROOT',
      'Persistence directory is outside its data root.',
    );
  }
  await mkdir(resolvedDirectory, { recursive: true, mode: SECURE_DIRECTORY_MODE });
  for (const part of secureDirectoryParts(root, resolvedDirectory)) {
    await secureDirectoryStatus(part);
  }
};

export const ensureSecureDirectorySync = (
  directory: string,
  options: { dataRoot?: string } = {},
): void => {
  const root = dataRootOf(path.join(directory, 'placeholder'), options.dataRoot ?? directory);
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(root, resolvedDirectory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SecureFileBoundaryError(
      'FILE_PATH_OUTSIDE_DATA_ROOT',
      'Persistence directory is outside its data root.',
    );
  }
  mkdirSync(resolvedDirectory, { recursive: true, mode: SECURE_DIRECTORY_MODE });
  for (const part of secureDirectoryParts(root, resolvedDirectory)) {
    secureDirectoryStatusSync(part);
  }
};

export const secureFileStats = async (
  file: string,
  options: { dataRoot?: string } = {},
): Promise<Stats> => {
  const root = assertSecurePath(file, options.dataRoot);
  await ensureSecureDirectory(path.dirname(file), { dataRoot: root });
  const details = await lstat(file);
  if (details.isSymbolicLink()) {
    throw new SecureFileBoundaryError(
      'FILE_SYMLINK_NOT_ALLOWED',
      'Persistence file symlinks are not allowed.',
    );
  }
  if (!details.isFile()) {
    throw new SecureFileBoundaryError(
      'FILE_NOT_REGULAR',
      'Persistence target is not a regular file.',
    );
  }
  ensureOwner(details);
  if (modeOf(details) !== SECURE_FILE_MODE) {
    try {
      await chmod(file, SECURE_FILE_MODE);
    } catch {
      throw new SecureFileBoundaryError(
        'FILE_PERMISSION_REPAIR_FAILED',
        'Persistence file permissions could not be restricted.',
      );
    }
    const repaired = await lstat(file);
    if (repaired.isSymbolicLink() || !repaired.isFile() || modeOf(repaired) !== SECURE_FILE_MODE) {
      throw new SecureFileBoundaryError(
        'FILE_PERMISSION_REPAIR_FAILED',
        'Persistence file permissions could not be verified.',
      );
    }
    ensureOwner(repaired);
    return repaired;
  }
  return details;
};

export const secureFileStatsSync = (
  file: string,
  options: { dataRoot?: string } = {},
): Stats => {
  const root = assertSecurePath(file, options.dataRoot);
  ensureSecureDirectorySync(path.dirname(file), { dataRoot: root });
  const details = lstatSync(file);
  if (details.isSymbolicLink()) {
    throw new SecureFileBoundaryError(
      'FILE_SYMLINK_NOT_ALLOWED',
      'Persistence file symlinks are not allowed.',
    );
  }
  if (!details.isFile()) {
    throw new SecureFileBoundaryError(
      'FILE_NOT_REGULAR',
      'Persistence target is not a regular file.',
    );
  }
  ensureOwner(details);
  if (modeOf(details) !== SECURE_FILE_MODE) {
    try {
      chmodSync(file, SECURE_FILE_MODE);
    } catch {
      throw new SecureFileBoundaryError(
        'FILE_PERMISSION_REPAIR_FAILED',
        'Persistence file permissions could not be restricted.',
      );
    }
    const repaired = lstatSync(file);
    if (repaired.isSymbolicLink() || !repaired.isFile() || modeOf(repaired) !== SECURE_FILE_MODE) {
      throw new SecureFileBoundaryError(
        'FILE_PERMISSION_REPAIR_FAILED',
        'Persistence file permissions could not be verified.',
      );
    }
    ensureOwner(repaired);
    return repaired;
  }
  return details;
};

export const readSecureFile = async (
  file: string,
  options: { dataRoot?: string; maxBytes?: number } = {},
): Promise<string> => {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PERSISTED_FILE_BYTES;
  validateMaxBytes(maxBytes);
  const expected = await secureFileStats(file, options);
  if (expected.size > maxBytes) {
    throw new SecureFileBoundaryError(
      'FILE_TOO_LARGE',
      'Persistence file exceeds its maximum byte size.',
    );
  }
  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      modeOf(opened) !== SECURE_FILE_MODE
    ) {
      throw new SecureFileBoundaryError(
        'FILE_NOT_REGULAR',
        'Persistence file changed during read.',
      );
    }
    if (opened.size > maxBytes) {
      throw new SecureFileBoundaryError(
        'FILE_TOO_LARGE',
        'Persistence file exceeds its maximum byte size.',
      );
    }
    const contents = await handle.readFile();
    if (contents.byteLength > maxBytes) {
      throw new SecureFileBoundaryError(
        'FILE_TOO_LARGE',
        'Persistence file exceeds its maximum byte size.',
      );
    }
    return contents.toString('utf8');
  } finally {
    await handle.close();
  }
};

/** Serialize mutations from separate server/CLI processes as well as callers
 * sharing one repository instance. The data file itself remains atomic. */
interface LockLease {
  schemaVersion: 1;
  pid: number;
  host: string;
  nonce: string;
  acquiredAt: number;
  expiresAt: number;
}

const lockHost = os.hostname();

const lockNonce = (): string =>
  `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const defaultProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorCode(error, 'ESRCH');
  }
};

const parseLockLease = (value: string): LockLease | undefined => {
  try {
    const parsed = JSON.parse(value) as Partial<LockLease>;
    if (
      parsed.schemaVersion !== 1 ||
      !Number.isInteger(parsed.pid) ||
      typeof parsed.host !== 'string' ||
      typeof parsed.nonce !== 'string' ||
      !Number.isFinite(parsed.acquiredAt) ||
      !Number.isFinite(parsed.expiresAt)
    ) return undefined;
    return parsed as LockLease;
  } catch {
    return undefined;
  }
};

const readLockLease = async (lockFile: string): Promise<LockLease | undefined> => {
  try {
    return parseLockLease(await readFile(lockFile, 'utf8'));
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
};

const lockIsStale = async (
  lockFile: string,
  options: Required<Pick<FileLockOptions, 'staleLockMs' | 'now' | 'isProcessAlive'>>,
): Promise<boolean> => {
  let details;
  try {
    details = await stat(lockFile);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
  const lease = await readLockLease(lockFile);
  if (lease && lease.host === lockHost && !options.isProcessAlive(lease.pid)) {
    return true;
  }
  const now = options.now();
  const leaseExpired = lease ? now >= lease.expiresAt : true;
  const oldEnough = now - details.mtimeMs >= options.staleLockMs;
  return leaseExpired && oldEnough;
};

const takeOverStaleLock = async (lockFile: string): Promise<void> => {
  const quarantine = `${lockFile}.${lockNonce()}.stale`;
  try {
    await rename(lockFile, quarantine);
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) throw error;
    return;
  }
  await rm(quarantine, { force: true });
};

const writeLockLease = async (
  handle: Awaited<ReturnType<typeof open>>,
  lease: LockLease,
): Promise<void> => {
  await handle.truncate(0);
  await handle.write(JSON.stringify(lease), 0, 'utf8');
  await handle.sync();
};

const refreshLockLease = async (
  lockFile: string,
  current: LockLease,
  now: () => number,
  leaseMs: number,
): Promise<void> => {
  const temp = `${lockFile}.${current.nonce}.heartbeat`;
  const refreshed: LockLease = {
    ...current,
    expiresAt: now() + leaseMs,
  };
  try {
    await writeFilePromise(temp, JSON.stringify(refreshed), {
      encoding: 'utf8',
      flag: 'wx',
      mode: SECURE_FILE_MODE,
    });
    const tempHandle = await open(temp, 'r');
    try {
      await tempHandle.sync();
    } finally {
      await tempHandle.close();
    }
    await rename(temp, lockFile);
    const directoryHandle = await open(path.dirname(lockFile), 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    try {
      await rm(temp, { force: true });
    } catch {
      // Best-effort cleanup; the current lock remains authoritative.
    }
    throw error;
  }
};

const releaseLock = async (
  lockFile: string,
  handle: Awaited<ReturnType<typeof open>>,
  nonce: string,
): Promise<void> => {
  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  let releaseError: unknown;
  try {
    const current = await readLockLease(lockFile);
    if (current?.nonce === nonce) await rm(lockFile);
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) releaseError = error;
  }
  if (closeError) throw closeError;
  if (releaseError) throw releaseError;
};

export async function withFileLock<T>(
  file: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const lockFile = `${file}.lock`;
  const retryDelayMs = options.retryDelayMs ?? 10;
  const maxAttempts = options.maxAttempts ?? 500;
  const leaseMs = options.leaseMs ?? DEFAULT_LOCK_LEASE_MS;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const now = options.now ?? Date.now;
  const isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
  await ensureSecureDirectory(path.dirname(lockFile));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let ownsLock = false;
    try {
      handle = await open(lockFile, 'wx', SECURE_FILE_MODE);
      await handle.chmod(SECURE_FILE_MODE);
      const nonce = lockNonce();
      const lease: LockLease = {
        schemaVersion: 1,
        pid: process.pid,
        host: lockHost,
        nonce,
        acquiredAt: now(),
        expiresAt: now() + leaseMs,
      };
      await writeLockLease(handle, lease);
      ownsLock = true;
      let heartbeat = Promise.resolve();
      const heartbeatTimer = setInterval(() => {
        heartbeat = heartbeat.then(async () => {
          const current = await readLockLease(lockFile);
          if (current?.nonce !== nonce) return;
          await refreshLockLease(lockFile, current, now, leaseMs);
        }).catch(() => undefined);
      }, Math.max(100, Math.floor(leaseMs / 3)));
      heartbeatTimer.unref?.();
      try {
        return await operation();
      } finally {
        clearInterval(heartbeatTimer);
        await heartbeat;
        await releaseLock(lockFile, handle, nonce);
      }
    } catch (error) {
      if (handle) {
        if (!ownsLock) {
          try {
            await handle.close();
          } finally {
            await rm(lockFile, { force: true });
          }
        }
        throw error;
      }
      if (!isErrorCode(error, 'EEXIST')) throw error;
      if (await lockIsStale(lockFile, { staleLockMs, now, isProcessAlive })) {
        await takeOverStaleLock(lockFile);
        continue;
      }
      await asyncSleep(retryDelayMs);
    }
  }

  throw new Error('Timed out acquiring persistence lock.');
}

const syncSleep = (delayMs: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
};

const isErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error &&
  'code' in error &&
  (error as NodeJS.ErrnoException).code === code;

const tempPathFor = (file: string): string =>
  `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

const safeLog = (
  logger: PersistenceLogger,
  file: string,
  error: unknown,
): void => {
  try {
    logger(`[server:persistence] Failed to persist ${path.basename(file)}`, error);
  } catch {
    // Logging must not turn a persistence failure into a process failure.
  }
};

export async function atomicWriteFile(
  file: string,
  value: PersistenceValue,
  options: AsyncAtomicWriteOptions = {},
): Promise<boolean> {
  const operations = { ...defaultAsyncOperations, ...options.operations };
  const sleep = options.sleep ?? asyncSleep;
  const logger = options.logger ?? defaultLogger;
  const temp = tempPathFor(file);

  try {
    const serialized = typeof value === 'function' ? value() : value;
    // The legacy unit-test operation shim uses relative virtual paths. Real
    // persistence targets are absolute and remain inside this boundary even
    // when a fault-injection operation is supplied.
    const secureFilesystem = options.operations === undefined || path.isAbsolute(file);
    if (secureFilesystem) {
      assertSecurePath(file, options.dataRoot);
      await ensureSecureDirectory(path.dirname(file), { dataRoot: options.dataRoot });
      try {
        await secureFileStats(file, { dataRoot: options.dataRoot });
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    await operations.mkdir(path.dirname(file), { recursive: true });
    await operations.writeFile(temp, serialized, 'utf8');
    if (secureFilesystem) {
      await chmod(temp, SECURE_FILE_MODE);
      await secureFileStats(temp, { dataRoot: options.dataRoot });
      await operations.sync(temp);
    }

    let renameError: unknown;
    let renamed = false;
    for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
      try {
        await operations.rename(temp, file);
        renamed = true;
        break;
      } catch (error) {
        renameError = error;
        if (!isErrorCode(error, 'EPERM') || attempt === RENAME_ATTEMPTS) break;
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
    if (!renamed) throw renameError;
    if (secureFilesystem) await secureFileStats(file, { dataRoot: options.dataRoot });
    if (secureFilesystem) await operations.sync(path.dirname(file));
    return true;
  } catch (error) {
    try {
      await operations.unlink(temp);
    } catch {
      // Best-effort cleanup after the final persistence failure.
    }
    safeLog(logger, file, error);
    throw error;
  }
}

export function atomicWriteFileSync(
  file: string,
  value: PersistenceValue,
  options: SyncAtomicWriteOptions = {},
): boolean {
  const operations = { ...defaultSyncOperations, ...options.operations };
  const sleep = options.sleep ?? syncSleep;
  const logger = options.logger ?? defaultLogger;
  const temp = tempPathFor(file);

  try {
    const serialized = typeof value === 'function' ? value() : value;
    const secureFilesystem = options.operations === undefined || path.isAbsolute(file);
    if (secureFilesystem) {
      assertSecurePath(file, options.dataRoot);
      ensureSecureDirectorySync(path.dirname(file), { dataRoot: options.dataRoot });
      try {
        secureFileStatsSync(file, { dataRoot: options.dataRoot });
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    operations.mkdir(path.dirname(file), { recursive: true });
    operations.writeFile(temp, serialized, 'utf8');
    if (secureFilesystem) {
      chmodSync(temp, SECURE_FILE_MODE);
      secureFileStatsSync(temp, { dataRoot: options.dataRoot });
      operations.sync(temp);
    }

    let renameError: unknown;
    let renamed = false;
    for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
      try {
        operations.rename(temp, file);
        renamed = true;
        break;
      } catch (error) {
        renameError = error;
        if (!isErrorCode(error, 'EPERM') || attempt === RENAME_ATTEMPTS) break;
        sleep(RETRY_DELAY_MS * attempt);
      }
    }
    if (!renamed) throw renameError;
    if (secureFilesystem) secureFileStatsSync(file, { dataRoot: options.dataRoot });
    if (secureFilesystem) operations.sync(path.dirname(file));
    return true;
  } catch (error) {
    try {
      operations.unlink(temp);
    } catch {
      // Best-effort cleanup after the final persistence failure.
    }
    safeLog(logger, file, error);
    throw error;
  }
}
