import {
  copyFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

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
}

export interface SyncAtomicWriteOptions {
  operations?: Partial<SyncAtomicFileOperations>;
  sleep?: (delayMs: number) => void;
  logger?: PersistenceLogger;
}

export interface FileLockOptions {
  retryDelayMs?: number;
  maxAttempts?: number;
}

const RENAME_ATTEMPTS = 4;
const RETRY_DELAY_MS = 10;

const defaultAsyncOperations: AsyncAtomicFileOperations = {
  mkdir,
  writeFile,
  rename,
  copyFile,
  unlink,
};

const defaultSyncOperations: SyncAtomicFileOperations = {
  mkdir: mkdirSync,
  writeFile: writeFileSync,
  rename: renameSync,
  copyFile: copyFileSync,
  unlink: unlinkSync,
};

const defaultLogger: PersistenceLogger = (message, error) => {
  console.error(message, error);
};

const asyncSleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

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
  await mkdir(path.dirname(lockFile), { recursive: true });

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockFile, 'wx');
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

  throw new Error(`Timed out acquiring persistence lock ${lockFile}.`);
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
    logger(`[server:persistence] Failed to persist ${file}`, error);
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
    await operations.mkdir(path.dirname(file), { recursive: true });
    await operations.writeFile(temp, serialized, 'utf8');

    for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
      try {
        await operations.rename(temp, file);
        return true;
      } catch (error) {
        if (!isErrorCode(error, 'EPERM') || attempt === RENAME_ATTEMPTS) break;
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }

    await operations.copyFile(temp, file);
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
    operations.mkdir(path.dirname(file), { recursive: true });
    operations.writeFile(temp, serialized, 'utf8');

    for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
      try {
        operations.rename(temp, file);
        return true;
      } catch (error) {
        if (!isErrorCode(error, 'EPERM') || attempt === RENAME_ATTEMPTS) break;
        sleep(RETRY_DELAY_MS * attempt);
      }
    }

    operations.copyFile(temp, file);
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
