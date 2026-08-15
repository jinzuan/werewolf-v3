import { isDeepStrictEqual } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  atomicWriteFile,
  type AsyncAtomicWriteOptions,
  withFileLock,
} from '../filePersistence';
import {
  migrateRoomRecord,
  migrateRoomRecords,
} from './roomMigration';
import {
  RoomRepositoryError,
  RoomRevisionConflictError,
  type RoomMutation,
  type RoomMutationOptions,
  type RoomRepository,
} from './repository';
import type { RuntimeEnvironment } from '../runtimeConfig';
import type { RoomRecord } from './types';

export const ROOM_FILE_SCHEMA_VERSION = 1;

interface RoomFileDocument {
  schemaVersion: number;
  environment: RuntimeEnvironment;
  deploymentNamespace: string;
  rooms: RoomRecord[];
}
export interface FileRoomRepositoryOptions extends AsyncAtomicWriteOptions {
  environment?: RuntimeEnvironment;
  deploymentNamespace?: string;
  /** Alias accepted by administrative callers. */
  namespace?: string;
}

const roomKey = (code: string): string => code.toUpperCase();
const clone = <T>(value: T): T => structuredClone(value);

const revisionOf = (room: RoomRecord): number =>
  Number.isInteger(room.roomRevision) && room.roomRevision! > 0
    ? room.roomRevision!
    : 1;

const configRevisionOf = (room: RoomRecord): number =>
  Number.isInteger(room.configRevision) && room.configRevision! > 0
    ? room.configRevision!
    : 1;

const factsOf = (room: RoomRecord): RoomRecord => {
  const facts = clone(room);
  delete facts.schemaVersion;
  delete facts.roomRevision;
  delete facts.rosterRevision;
  delete facts.configRevision;
  delete facts.updatedAt;
  return facts;
};

const rosterRevisionOf = (room: RoomRecord): number =>
  Number.isInteger(room.rosterRevision) && room.rosterRevision! > 0
    ? room.rosterRevision!
    : 1;

const configOf = (room: RoomRecord): unknown => clone(room.config);

const prepareSave = (
  current: RoomRecord | undefined,
  incoming: RoomRecord,
): RoomRecord => {
  if (!current) return incoming;
  const currentRevision = revisionOf(current);
  const incomingRevision = revisionOf(incoming);
  if (incomingRevision < currentRevision) {
    throw new RoomRevisionConflictError(
      incoming.code,
      incomingRevision,
      currentRevision,
    );
  }
  if (isDeepStrictEqual(factsOf(current), factsOf(incoming))) {
    return incomingRevision > currentRevision ? incoming : current;
  }
  const configChanged = !isDeepStrictEqual(
    configOf(current),
    configOf(incoming),
  );
  incoming.roomRevision = Math.max(currentRevision + 1, incomingRevision);
  incoming.rosterRevision = !isDeepStrictEqual(current.members, incoming.members)
    ? rosterRevisionOf(current) + 1
    : rosterRevisionOf(current);
  incoming.configRevision = configChanged
    ? Math.max(configRevisionOf(current) + 1, incoming.configRevision ?? 1)
    : configRevisionOf(current);
  incoming.updatedAt = Date.now();
  return incoming;
};

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  (error as NodeJS.ErrnoException).code === 'ENOENT';

const fileRevision = async (file: string): Promise<string | undefined> => {
  try {
    const details = await stat(file);
    return `${details.dev}:${details.ino}:${details.size}:${details.mtimeMs}:${details.ctimeMs}`;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
};

export class FileRoomRepository implements RoomRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private rooms?: RoomRecord[];
  private diskRevision?: string;
  private dirty = false;
  readonly environment: RuntimeEnvironment;
  readonly deploymentNamespace: string;
  private readonly persistence: AsyncAtomicWriteOptions;

  constructor(
    readonly filePath: string,
    options: FileRoomRepositoryOptions = {},
  ) {
    if (!path.isAbsolute(filePath)) {
      throw new TypeError('FileRoomRepository requires an absolute file path.');
    }
    this.environment = options.environment ?? 'development';
    this.deploymentNamespace =
      options.deploymentNamespace ?? options.namespace ?? 'default';
    this.persistence = {
      operations: options.operations,
      sleep: options.sleep,
      logger: options.logger,
    };
  }

  list(): Promise<RoomRecord[]> {
    return this.enqueue(() =>
      withFileLock(this.filePath, async () => clone(await this.load())),
    );
  }

  get(code: string): Promise<RoomRecord | undefined> {
    return this.enqueue(() =>
      withFileLock(this.filePath, async () => {
        const room = (await this.load()).find(
          (item) => item.code === roomKey(code),
        );
        return room ? clone(room) : undefined;
      }),
    );
  }

  create(room: RoomRecord): Promise<RoomRecord> {
    return this.enqueue(() =>
      withFileLock(this.filePath, async () => {
        const rooms = await this.load();
        const migrated = this.normalizeRoom(room);
        const key = roomKey(migrated.code);
        if (rooms.some((item) => item.code === key)) {
          throw new RoomRepositoryError(
            `Room ${key} already exists`,
            'ROOM_ALREADY_EXISTS',
          );
        }
        rooms.push(migrated);
        this.rooms = rooms;
        await this.write(rooms);
        return clone(migrated);
      }),
    );
  }

  createOrGetByRequest(
    requestId: string,
    actorId: string,
    fingerprint: string,
    factory: () => RoomRecord,
  ): Promise<{ room: RoomRecord; created: boolean }> {
    return this.enqueue(() =>
      withFileLock(this.filePath, async () => {
        const rooms = await this.load();
        const existing = rooms.find((room) => room.createRequestId === requestId);
        if (existing) {
          if (
            existing.createActorId !== actorId ||
            existing.createFingerprint !== fingerprint
          ) {
            throw new RoomRepositoryError(
              `Create request ${requestId} was reused with different data`,
              'IDEMPOTENCY_KEY_REUSED',
            );
          }
          return { room: clone(existing), created: false };
        }

        const room = this.normalizeRoom(migrateRoomRecord(factory()));
        room.createRequestId = requestId;
        room.createActorId = actorId;
        room.createFingerprint = fingerprint;
        const key = roomKey(room.code);
        if (rooms.some((item) => item.code === key)) {
          throw new RoomRepositoryError(
            `Room ${key} already exists`,
            'ROOM_ALREADY_EXISTS',
          );
        }
        rooms.push(room);
        this.rooms = rooms;
        await this.write(rooms);
        return { room: clone(room), created: true };
      }),
    );
  }

  save(room: RoomRecord): Promise<void> {
    return this.enqueue(() =>
      withFileLock(this.filePath, async () => {
        const rooms = await this.load();
        const migrated = this.normalizeRoom(room);
        const index = rooms.findIndex(
          (item) => item.code === roomKey(migrated.code),
        );
        const current = index === -1 ? undefined : rooms[index];
        const next = prepareSave(current, migrated);
        if (index === -1) rooms.push(next);
        else rooms[index] = next;
        this.rooms = rooms;
        await this.write(rooms);
      }),
    );
  }

  remove(code: string): Promise<void> {
    return this.enqueue(() =>
      withFileLock(this.filePath, async () => {
        const rooms = await this.load();
        this.rooms = rooms.filter((room) => room.code !== roomKey(code));
        await this.write(this.rooms);
      }),
    );
  }

  mutate<T = RoomRecord>(
    code: string,
    mutation: RoomMutation<T>,
    options?: RoomMutationOptions | number,
  ): Promise<T>;
  mutate<T = RoomRecord>(
    code: string,
    expectedRoomRevision: number,
    mutation: RoomMutation<T>,
  ): Promise<T>;
  mutate<T = RoomRecord>(
    code: string,
    expectedOrMutation: number | RoomMutation<T>,
    mutationOrOptions?: RoomMutation<T> | RoomMutationOptions | number,
  ): Promise<T> {
    const expectedRevision =
      typeof expectedOrMutation === 'number'
        ? expectedOrMutation
        : typeof mutationOrOptions === 'number'
          ? mutationOrOptions
          : typeof mutationOrOptions === 'object'
            ? mutationOrOptions?.expectedRoomRevision ??
              mutationOrOptions?.expectedRevision
            : undefined;
    const mutation =
      typeof expectedOrMutation === 'function'
        ? expectedOrMutation
        : mutationOrOptions as RoomMutation<T>;

    return this.enqueue(() =>
      withFileLock(this.filePath, async () => {
        const rooms = await this.load();
        const index = rooms.findIndex((item) => item.code === roomKey(code));
        if (index === -1) {
          throw new RoomRepositoryError(
            `Room ${roomKey(code)} does not exist`,
            'ROOM_NOT_FOUND',
          );
        }
        const current = clone(rooms[index]);
        const actualRevision = revisionOf(current);
        if (
          expectedRevision !== undefined &&
          expectedRevision !== actualRevision
        ) {
          throw new RoomRevisionConflictError(
            current.code,
            expectedRevision,
            actualRevision,
          );
        }
        const draft = clone(current);
        const returned = await mutation(draft);
        const candidate =
          returned &&
          typeof returned === 'object' &&
          'id' in returned &&
          'code' in returned &&
          'members' in returned &&
          'players' in returned
            ? (returned as unknown as RoomRecord)
            : draft;
        const next = this.normalizeRoom(migrateRoomRecord(candidate));
        const changed = !isDeepStrictEqual(factsOf(current), factsOf(next));
        if (!changed) {
          return (returned === undefined ? clone(current) : returned) as T;
        }
        const configChanged = !isDeepStrictEqual(
          configOf(current),
          configOf(next),
        );
        next.roomRevision = actualRevision + 1;
        next.rosterRevision = !isDeepStrictEqual(current.members, next.members)
          ? rosterRevisionOf(current) + 1
          : rosterRevisionOf(current);
        next.configRevision = configChanged
          ? configRevisionOf(current) + 1
          : configRevisionOf(current);
        next.updatedAt = Date.now();
        rooms[index] = next;
        this.rooms = rooms;
        await this.write(rooms);
        return (returned === undefined ? clone(next) : returned) as T;
      }),
    );
  }

  compareAndSet<T = RoomRecord>(
    code: string,
    expectedRoomRevision: number,
    mutation: RoomMutation<T>,
  ): Promise<T> {
    return this.mutate(code, expectedRoomRevision, mutation);
  }

  cas<T = RoomRecord>(
    code: string,
    expectedRoomRevision: number,
    mutation: RoomMutation<T>,
  ): Promise<T> {
    return this.compareAndSet(code, expectedRoomRevision, mutation);
  }

  private normalizeRoom(room: RoomRecord): RoomRecord {
    if (
      room.environment !== undefined &&
      room.environment !== this.environment
    ) {
      throw new RoomRepositoryError(
        `Room ${room.code} belongs to environment ${room.environment}.`,
        'DATA_ENVIRONMENT_MISMATCH',
      );
    }
    if (
      room.deploymentNamespace !== undefined &&
      room.deploymentNamespace !== this.deploymentNamespace
    ) {
      throw new RoomRepositoryError(
        `Room ${room.code} belongs to namespace ${room.deploymentNamespace}.`,
        'DATA_NAMESPACE_MISMATCH',
      );
    }
    return {
      ...migrateRoomRecord(room),
      environment: this.environment,
      deploymentNamespace: this.deploymentNamespace,
    };
  }

  private async load(): Promise<RoomRecord[]> {
    const revision = await fileRevision(this.filePath);
    if (
      this.rooms &&
      revision === this.diskRevision
    ) {
      return this.rooms;
    }
    // A failed write intentionally leaves the process-local authoritative
    // state available to its caller. An external controlled write changes the
    // disk revision and therefore clears this exception on the next read.
    if (this.rooms && this.dirty && revision === this.diskRevision) {
      return this.rooms;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.rooms = [];
      this.diskRevision = undefined;
      this.dirty = false;
      return this.rooms;
    }

    const source = this.parseDocument(parsed);
    const migrated = migrateRoomRecords(source).map((room) =>
      this.normalizeRoom(room),
    );
    this.rooms = migrated;
    this.diskRevision = revision;
    this.dirty = false;

    if (!this.isCurrentDocument(parsed, migrated)) {
      await this.write(migrated);
    }
    return this.rooms;
  }

  private parseDocument(value: unknown): RoomRecord[] {
    if (Array.isArray(value)) return value as RoomRecord[];
    if (!value || typeof value !== 'object') {
      throw new RoomRepositoryError(
        'Room data file is not a JSON room document.',
        'DATA_FILE_INVALID',
      );
    }
    const document = value as Partial<RoomFileDocument> & {
      rooms?: unknown;
    };
    if (document.schemaVersion !== ROOM_FILE_SCHEMA_VERSION) {
      throw new RoomRepositoryError(
        `Unsupported room data schema ${String(document.schemaVersion)}.`,
        'DATA_SCHEMA_UNSUPPORTED',
      );
    }
    if (document.deploymentNamespace !== this.deploymentNamespace) {
      throw new RoomRepositoryError(
        'Room data belongs to another deployment namespace.',
        'DATA_NAMESPACE_MISMATCH',
      );
    }
    if (document.environment && document.environment !== this.environment) {
      throw new RoomRepositoryError(
        'Room data belongs to another runtime environment.',
        'DATA_ENVIRONMENT_MISMATCH',
      );
    }
    if (!Array.isArray(document.rooms)) {
      throw new RoomRepositoryError(
        'Room data document has no rooms array.',
        'DATA_FILE_INVALID',
      );
    }
    return document.rooms as RoomRecord[];
  }

  private isCurrentDocument(value: unknown, rooms: RoomRecord[]): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const document = value as Partial<RoomFileDocument>;
    return (
      document.schemaVersion === ROOM_FILE_SCHEMA_VERSION &&
      document.environment === this.environment &&
      document.deploymentNamespace === this.deploymentNamespace &&
      isDeepStrictEqual(document.rooms, rooms)
    );
  }

  private async write(rooms: RoomRecord[]): Promise<void> {
    const document: RoomFileDocument = {
      schemaVersion: ROOM_FILE_SCHEMA_VERSION,
      environment: this.environment,
      deploymentNamespace: this.deploymentNamespace,
      rooms,
    };
    const persisted = await atomicWriteFile(
      this.filePath,
      () => JSON.stringify(document, null, 2),
      this.persistence,
    );
    if (persisted) {
      this.diskRevision = await fileRevision(this.filePath);
      this.dirty = false;
    } else {
      this.dirty = true;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
