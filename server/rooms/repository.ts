import { isDeepStrictEqual } from 'node:util';
import { migrateRoomRecord } from './roomMigration';
import type { RoomRecord } from './types';

export interface RoomMutationOptions {
  expectedRoomRevision?: number;
  /** Alias useful to callers that use the shorter CAS terminology. */
  expectedRevision?: number;
}

export type RoomMutationValue = RoomRecord | void | unknown;
export type RoomMutation<T = RoomMutationValue> = (
  room: RoomRecord,
) => T | Promise<T>;

export class RoomRepositoryError extends Error {
  constructor(
    message: string,
    public readonly code: 'ROOM_NOT_FOUND' | 'ROOM_ALREADY_EXISTS' | string,
  ) {
    super(message);
    this.name = 'RoomRepositoryError';
  }
}

export class RoomRevisionConflictError extends RoomRepositoryError {
  constructor(
    public readonly roomCode: string,
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super(
      `Room ${roomCode} is at revision ${actualRevision}; expected ${expectedRevision}`,
      'ROOM_REVISION_CONFLICT',
    );
    this.name = 'RoomRevisionConflictError';
  }
}

export interface RoomRepository {
  list(): Promise<RoomRecord[]>;
  get(code: string): Promise<RoomRecord | undefined>;
  create(room: RoomRecord): Promise<RoomRecord>;
  /** Atomically claim a durable create request, returning the existing room on retry. */
  createOrGetByRequest(
    requestId: string,
    actorId: string,
    fingerprint: string,
    factory: () => RoomRecord,
  ): Promise<{ room: RoomRecord; created: boolean }>;
  save(room: RoomRecord): Promise<void>;
  remove(code: string): Promise<void>;

  /** Read, mutate, revision-check and persist in one atomic repository turn. */
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

  compareAndSet<T = RoomRecord>(
    code: string,
    expectedRoomRevision: number,
    mutation: RoomMutation<T>,
  ): Promise<T>;
  cas<T = RoomRecord>(
    code: string,
    expectedRoomRevision: number,
    mutation: RoomMutation<T>,
  ): Promise<T>;
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

/** Revision fields are repository-owned and cannot be forged by a mutator. */
const factsOf = (room: RoomRecord): RoomRecord => {
  const facts = clone(room);
  delete facts.schemaVersion;
  delete facts.roomRevision;
  delete facts.configRevision;
  delete facts.updatedAt;
  return facts;
};

const configOf = (room: RoomRecord): unknown => clone(room.config);

const isRoomRecord = (value: unknown): value is RoomRecord =>
  Boolean(
    value &&
      typeof value === 'object' &&
      'id' in value &&
      'code' in value &&
      'members' in value &&
      'players' in value,
  );

const normalizeExpectedRevision = (
  options: RoomMutationOptions | number | undefined,
): number | undefined => {
  if (typeof options === 'number') return options;
  return options?.expectedRoomRevision ?? options?.expectedRevision;
};

interface ParsedMutation<T> {
  mutation: RoomMutation<T>;
  expectedRevision?: number;
}

const parseMutationArgs = <T>(
  expectedOrMutation: number | RoomMutation<T>,
  mutationOrOptions?: RoomMutation<T> | RoomMutationOptions | number,
): ParsedMutation<T> => {
  if (typeof expectedOrMutation === 'function') {
    return {
      mutation: expectedOrMutation,
      expectedRevision: normalizeExpectedRevision(
        mutationOrOptions as RoomMutationOptions | number | undefined,
      ),
    };
  }
  if (typeof mutationOrOptions !== 'function') {
    throw new TypeError('Room mutate requires a mutation callback');
  }
  return {
    mutation: mutationOrOptions,
    expectedRevision: expectedOrMutation,
  };
};

interface MutationOutcome<T> {
  room: RoomRecord;
  result: T;
}

const applyMutation = async <T>(
  current: RoomRecord,
  parsed: ParsedMutation<T>,
): Promise<MutationOutcome<T>> => {
  const actualRevision = revisionOf(current);
  if (
    parsed.expectedRevision !== undefined &&
    parsed.expectedRevision !== actualRevision
  ) {
    throw new RoomRevisionConflictError(
      current.code,
      parsed.expectedRevision,
      actualRevision,
    );
  }

  const draft = clone(current);
  const returned = await parsed.mutation(draft);
  const next = migrateRoomRecord(
    isRoomRecord(returned) ? returned : draft,
  );
  const changed = !isDeepStrictEqual(factsOf(current), factsOf(next));

  if (!changed) {
    return {
      room: current,
      result: (returned === undefined ? clone(current) : returned) as T,
    };
  }

  const configChanged = !isDeepStrictEqual(configOf(current), configOf(next));
  next.roomRevision = actualRevision + 1;
  next.configRevision = configChanged
    ? configRevisionOf(current) + 1
    : configRevisionOf(current);
  next.updatedAt = Date.now();
  return {
    room: next,
    result: (returned === undefined ? clone(next) : returned) as T,
  };
};

abstract class SerializedRoomRepository implements RoomRepository {
  protected queue: Promise<unknown> = Promise.resolve();

  abstract list(): Promise<RoomRecord[]>;
  abstract get(code: string): Promise<RoomRecord | undefined>;
  abstract create(room: RoomRecord): Promise<RoomRecord>;
  abstract createOrGetByRequest(
    requestId: string,
    actorId: string,
    fingerprint: string,
    factory: () => RoomRecord,
  ): Promise<{ room: RoomRecord; created: boolean }>;
  abstract save(room: RoomRecord): Promise<void>;
  abstract remove(code: string): Promise<void>;
  protected abstract readForMutation(code: string): Promise<RoomRecord | undefined>;
  protected abstract writeMutation(room: RoomRecord): Promise<void>;

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
    const parsed = parseMutationArgs(
      expectedOrMutation,
      mutationOrOptions,
    );
    return this.enqueue(async () => {
      const current = await this.readForMutation(code);
      if (!current) {
        throw new RoomRepositoryError(
          `Room ${roomKey(code)} does not exist`,
          'ROOM_NOT_FOUND',
        );
      }
      const outcome = await applyMutation(current, parsed);
      if (outcome.room !== current) await this.writeMutation(outcome.room);
      return outcome.result;
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

  protected enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export class InMemoryRoomRepository extends SerializedRoomRepository {
  private readonly rooms = new Map<string, RoomRecord>();

  constructor(initialRooms: readonly RoomRecord[] = []) {
    super();
    for (const room of initialRooms) {
      const migrated = migrateRoomRecord(room);
      this.rooms.set(roomKey(migrated.code), migrated);
    }
  }

  list(): Promise<RoomRecord[]> {
    return this.enqueue(async () =>
      [...this.rooms.values()].map((room) => clone(migrateRoomRecord(room))),
    );
  }

  get(code: string): Promise<RoomRecord | undefined> {
    return this.enqueue(async () => {
      const room = this.rooms.get(roomKey(code));
      return room ? clone(migrateRoomRecord(room)) : undefined;
    });
  }

  create(room: RoomRecord): Promise<RoomRecord> {
    return this.enqueue(async () => {
      const migrated = migrateRoomRecord(room);
      const key = roomKey(migrated.code);
      if (this.rooms.has(key)) {
        throw new RoomRepositoryError(
          `Room ${key} already exists`,
          'ROOM_ALREADY_EXISTS',
        );
      }
      this.rooms.set(key, migrated);
      return clone(migrated);
    });
  }

  createOrGetByRequest(
    requestId: string,
    actorId: string,
    fingerprint: string,
    factory: () => RoomRecord,
  ): Promise<{ room: RoomRecord; created: boolean }> {
    return this.enqueue(async () => {
      const existing = [...this.rooms.values()].find(
        (room) => room.createRequestId === requestId,
      );
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
      const room = migrateRoomRecord(factory());
      const key = roomKey(room.code);
      if (this.rooms.has(key)) {
        throw new RoomRepositoryError(
          `Room ${key} already exists`,
          'ROOM_ALREADY_EXISTS',
        );
      }
      room.createRequestId = requestId;
      room.createActorId = actorId;
      room.createFingerprint = fingerprint;
      this.rooms.set(key, room);
      return { room: clone(room), created: true };
    });
  }

  save(room: RoomRecord): Promise<void> {
    return this.enqueue(async () => {
      const migrated = migrateRoomRecord(room);
      const key = roomKey(migrated.code);
      const current = this.rooms.get(key);
      const next = this.prepareSave(current, migrated);
      this.rooms.set(key, next);
    });
  }

  remove(code: string): Promise<void> {
    return this.enqueue(async () => {
      this.rooms.delete(roomKey(code));
    });
  }

  protected readForMutation(code: string): Promise<RoomRecord | undefined> {
    const room = this.rooms.get(roomKey(code));
    return Promise.resolve(room ? clone(migrateRoomRecord(room)) : undefined);
  }

  protected writeMutation(room: RoomRecord): Promise<void> {
    this.rooms.set(roomKey(room.code), clone(room));
    return Promise.resolve();
  }

  private prepareSave(
    current: RoomRecord | undefined,
    incoming: RoomRecord,
  ): RoomRecord {
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
  }
}
