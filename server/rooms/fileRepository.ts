import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  atomicWriteFile,
  type AsyncAtomicWriteOptions,
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
import type { RoomRecord } from './types';

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
  delete facts.configRevision;
  delete facts.updatedAt;
  return facts;
};

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
  incoming.configRevision = configChanged
    ? Math.max(configRevisionOf(current) + 1, incoming.configRevision ?? 1)
    : configRevisionOf(current);
  incoming.updatedAt = Date.now();
  return incoming;
};

export class FileRoomRepository implements RoomRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private rooms?: RoomRecord[];

  constructor(
    private readonly filePath = path.resolve(
      process.cwd(),
      'server',
      'data',
      'v3-rooms.json',
    ),
    private readonly persistence: AsyncAtomicWriteOptions = {},
  ) {}

  list(): Promise<RoomRecord[]> {
    return this.enqueue(async () => clone(await this.load()));
  }

  get(code: string): Promise<RoomRecord | undefined> {
    return this.enqueue(async () => {
      const room = (await this.load()).find(
        (item) => item.code === roomKey(code),
      );
      return room ? clone(room) : undefined;
    });
  }

  create(room: RoomRecord): Promise<RoomRecord> {
    return this.enqueue(async () => {
      const rooms = await this.load();
      const migrated = migrateRoomRecord(room);
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
    });
  }

  save(room: RoomRecord): Promise<void> {
    return this.enqueue(async () => {
      const rooms = await this.load();
      const migrated = migrateRoomRecord(room);
      const index = rooms.findIndex(
        (item) => item.code === roomKey(migrated.code),
      );
      const current = index === -1 ? undefined : rooms[index];
      const next = prepareSave(current, migrated);
      if (index === -1) rooms.push(next);
      else rooms[index] = next;
      this.rooms = rooms;
      await this.write(rooms);
    });
  }

  remove(code: string): Promise<void> {
    return this.enqueue(async () => {
      const rooms = await this.load();
      this.rooms = rooms.filter((room) => room.code !== roomKey(code));
      await this.write(this.rooms);
    });
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
    // Keep the actual read-modify-write inside this queue. The repository
    // interface accepts both mutate(code, fn, options) and
    // mutate(code, expectedRevision, fn) for CAS call sites.
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
    return this.enqueue(async () => {
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
      const next = migrateRoomRecord(
        returned &&
          typeof returned === 'object' &&
          'id' in returned &&
          'code' in returned &&
          'members' in returned &&
          'players' in returned
          ? (returned as RoomRecord)
          : draft,
      );
      const changed = !isDeepStrictEqual(factsOf(current), factsOf(next));
      if (!changed) {
        return (returned === undefined ? clone(current) : returned) as T;
      }
      const configChanged = !isDeepStrictEqual(
        configOf(current),
        configOf(next),
      );
      next.roomRevision = actualRevision + 1;
      next.configRevision = configChanged
        ? configRevisionOf(current) + 1
        : configRevisionOf(current);
      next.updatedAt = Date.now();
      rooms[index] = next;
      this.rooms = rooms;
      await this.write(rooms);
      return (returned === undefined ? clone(next) : returned) as T;
    });
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

  private async load(): Promise<RoomRecord[]> {
    if (this.rooms) return this.rooms;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch {
      this.rooms = [];
      return this.rooms;
    }

    const source = Array.isArray(parsed) ? (parsed as RoomRecord[]) : [];
    const migrated = migrateRoomRecords(source);
    this.rooms = migrated;
    if (JSON.stringify(source) !== JSON.stringify(migrated)) {
      // Persist migration in the same serialized turn as the first read. A
      // restart therefore sees the same schema and does not mint new tokens.
      await this.write(migrated);
    }
    return this.rooms;
  }

  private async write(rooms: RoomRecord[]): Promise<void> {
    await atomicWriteFile(
      this.filePath,
      () => JSON.stringify(rooms, null, 2),
      this.persistence,
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
