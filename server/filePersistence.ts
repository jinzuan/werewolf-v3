import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  unlink,
  writeFile as writeFilePromise,
} from 'node:fs/promises';
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
  copyFile(source: string, destination: string): Promise<unknown>;
  unlink(file: string): Promise<unknown>;
}

export interface SyncAtomicFileOperations {
  mkdir(directory: string, options: { recursive: true }): unknown;
  writeFile(file: string, value: string, encoding: 'utf8'): unknown;
  rename(source: string, destination: string): unknown;
  copyFile(source: string, destination: string): unknown;
  unlink(file: string): unknown;
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
}

const RENAME_ATTEMPTS = 4;
const RETRY_DELAY_MS = 10;

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
  copyFile,
  unlink,
};

const defaultSyncOperations: SyncAtomicFileOperations = {
  mkdir: mkdirSync,
  writeFile: secureSyncWriteFile,
  rename: renameSync,
  copyFile: copyFileSync,
  unlink: unlinkSync,
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
export async function withFileLock<T>(
  file: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const lockFile = `${file}.lock`;
  const retryDelayMs = options.retryDelayMs ?? 10;
  const maxAttempts = options.maxAttempts ?? 500;
  await ensureSecureDirectory(path.dirname(lockFile));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockFile, 'wx', SECURE_FILE_MODE);
      await handle.chmod(SECURE_FILE_MODE);
      try {
        return await operation();
      } finally {
        await handle.close();
        await rm(lockFile, { force: true });
      }
    } catch (error) {
      if (handle || !isErrorCode(error, 'EEXIST')) throw error;
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
    }

    for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
      try {
        await operations.rename(temp, file);
        if (secureFilesystem) await secureFileStats(file, { dataRoot: options.dataRoot });
        return true;
      } catch (error) {
        if (!isErrorCode(error, 'EPERM') || attempt === RENAME_ATTEMPTS) break;
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }

    await operations.copyFile(temp, file);
    if (secureFilesystem) await secureFileStats(file, { dataRoot: options.dataRoot });
    try {
      await operations.unlink(temp);
    } catch {
      // The destination is complete; a stale temp file is safe to leave behind.
    }
    return true;
  } catch (error) {
    try {
      await operations.unlink(temp);
    } catch {
      // Best-effort cleanup after the final persistence failure.
    }
    safeLog(logger, file, error);
    return false;
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
    }

    for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
      try {
        operations.rename(temp, file);
        if (secureFilesystem) secureFileStatsSync(file, { dataRoot: options.dataRoot });
        return true;
      } catch (error) {
        if (!isErrorCode(error, 'EPERM') || attempt === RENAME_ATTEMPTS) break;
        sleep(RETRY_DELAY_MS * attempt);
      }
    }

    operations.copyFile(temp, file);
    if (secureFilesystem) secureFileStatsSync(file, { dataRoot: options.dataRoot });
    try {
      operations.unlink(temp);
    } catch {
      // The destination is complete; a stale temp file is safe to leave behind.
    }
    return true;
  } catch (error) {
    try {
      operations.unlink(temp);
    } catch {
      // Best-effort cleanup after the final persistence failure.
    }
    safeLog(logger, file, error);
    return false;
  }
}
