import { randomUUID } from 'node:crypto';
import type { CommandReceipt, RoomView } from '../../shared/protocol';
import type { RoomCredentialStore } from '../security/roomCredentialStore';
import type { RuntimeEnvironment } from '../runtimeConfig';
import type { RoomRecord } from './types';
import {
  InMemoryLifecycleOutbox,
  lifecycleOperationId,
  type LifecycleIntent,
  type LifecycleOutbox,
  type RoomLifecycleKind,
} from './lifecycleOutbox';
import type { RoomRepository } from './repository';

export interface RoomTombstone {
  schemaVersion: 1;
  environment: string;
  deploymentNamespace: string;
  revision: number;
  roomCode: string;
  roomId: string;
  reason: 'dissolved' | 'last_member_left' | 'expired';
  closedAt: number;
  retainedUntil: number;
  causeCommandId?: string;
  /** Authentication-safe summary used only for command reconciliation. */
  authSummary: {
    actorIds: string[];
    memberCount: number;
    resumeTokenDigests: string[];
  };
}

export interface RoomMutationResult {
  receipt: CommandReceipt;
  room?: RoomView;
  tombstone?: RoomTombstone;
  summary?: Record<string, unknown> | null;
  roomRevision?: number;
}

export const ROOM_TOMBSTONE_SCHEMA_VERSION = 1;

export interface RoomLifecycleServiceOptions {
  environment: RuntimeEnvironment;
  deploymentNamespace: string;
  credentialNamespace?: string;
  credentialStore?: RoomCredentialStore;
  outbox?: LifecycleOutbox;
  clock?: () => number;
  retryBaseMs?: number;
  onCommitted?: (room: RoomRecord, intent: LifecycleIntent) => void | Promise<void>;
  /** Dispose all in-memory resources owned by the room. */
  onCleanup?: (room: RoomRecord | undefined, intent: LifecycleIntent) => void | Promise<void>;
}

export interface LifecycleCommitResult {
  operationId: string;
  committed: true;
  cleanupPending: boolean;
}

const clone = <T>(value: T): T => structuredClone(value);
const safeErrorCode = (error: unknown): string => {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'CLEANUP_FAILED';
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'CLEANUP_FAILED';
};

/**
 * The only owner of room termination. It commits an auditable tombstone and
 * intent first, then performs best-effort cleanup with durable retries.
 */
export class RoomLifecycleService {
  private readonly outbox: LifecycleOutbox;
  private readonly now: () => number;
  private readonly retryBaseMs: number;
  // Command receipts/tombstones outlive a terminal room in this process so a
  // client can reconcile an ACK that raced room cleanup. Durable room facts
  // remain owned by RoomRepository and the lifecycle outbox.
  private readonly receipts = new Map<string, CommandReceipt>();
  private readonly tombstones = new Map<string, RoomTombstone>();

  constructor(
    private readonly repository: RoomRepository,
    private readonly options: RoomLifecycleServiceOptions,
  ) {
    this.outbox = options.outbox ?? new InMemoryLifecycleOutbox();
    this.now = options.clock ?? Date.now;
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
  }

  rememberReceipt(receipt: CommandReceipt): CommandReceipt {
    const stored = clone(receipt);
    this.receipts.set(this.key(receipt.roomCode, receipt.commandId), stored);
    return clone(stored);
  }

  rememberTombstone(tombstone: RoomTombstone): RoomTombstone {
    const stored = clone(tombstone);
    this.tombstones.set(stored.roomCode.toUpperCase(), stored);
    return clone(stored);
  }

  getReceipt(roomCode: string, commandId: string): CommandReceipt | undefined {
    const receipt = this.receipts.get(this.key(roomCode, commandId));
    return receipt ? clone(receipt) : undefined;
  }

  getTombstone(roomCode: string): RoomTombstone | undefined {
    const tombstone = this.tombstones.get(roomCode.toUpperCase());
    return tombstone ? clone(tombstone) : undefined;
  }

  clear(roomCode: string): void {
    const prefix = `${roomCode.toUpperCase()}:`;
    for (const key of this.receipts.keys()) {
      if (key.startsWith(prefix)) this.receipts.delete(key);
    }
    this.tombstones.delete(roomCode.toUpperCase());
  }

  async commit(
    roomCode: string,
    kind: Exclude<RoomLifecycleKind, 'mode_switch'>,
  ): Promise<LifecycleCommitResult> {
    const existing = await this.repository.get(roomCode);
    if (!existing) {
      return { operationId: `missing:${roomCode}`, committed: true, cleanupPending: false };
    }
    const existingTombstone = existing.lifecycleTombstone;
    let operationId = existingTombstone?.operationId;
    if (!operationId) {
      operationId = lifecycleOperationId();
      const createdAt = this.now();
      await this.repository.mutate(roomCode, (room) => {
        const currentOperationId = room.lifecycleTombstone?.operationId ?? operationId!;
        room.status = 'ended';
        room.closedAt = room.closedAt ?? createdAt;
        room.closeReason = 'dissolved';
        room.lifecycleTombstone = {
          schemaVersion: ROOM_TOMBSTONE_SCHEMA_VERSION,
          environment: room.environment ?? this.options.environment,
          deploymentNamespace: room.deploymentNamespace ?? this.options.deploymentNamespace,
          operationId: currentOperationId,
          roomCode: room.code,
          roomId: room.id,
          kind,
          closedAt: room.closedAt,
          ...(room.config?.credentialRef ? { credentialRef: room.config.credentialRef } : {}),
        };
        operationId = currentOperationId;
      });
    }

    const room = await this.repository.get(roomCode);
    if (!room) return { operationId, committed: true, cleanupPending: false };
    const intent: LifecycleIntent = {
      schemaVersion: 1,
      environment: room.environment ?? this.options.environment,
      deploymentNamespace: room.deploymentNamespace ?? this.options.deploymentNamespace,
      revision: room.roomRevision ?? 1,
      operationId,
      roomCode: room.code,
      roomId: room.id,
      kind,
      terminal: true,
      ...(room.lifecycleTombstone?.credentialRef || room.config?.credentialRef
        ? { credentialRef: room.lifecycleTombstone?.credentialRef ?? room.config?.credentialRef }
        : {}),
      attempts: 0,
      nextRetryAt: this.now(),
      createdAt: room.lifecycleTombstone?.closedAt ?? this.now(),
      updatedAt: this.now(),
    };
    await this.outbox.put(intent);
    await this.options.onCommitted?.(clone(room), clone(intent));
    const completed = await this.process(intent);
    return { operationId, committed: true, cleanupPending: !completed };
  }

  /** Queue a non-terminal cleanup, such as a credential removed by mode switch. */
  async enqueueCleanup(
    room: RoomRecord,
    kind: 'mode_switch',
    credentialRef: string,
  ): Promise<LifecycleCommitResult> {
    const intent: LifecycleIntent = {
      schemaVersion: 1,
      environment: room.environment ?? this.options.environment,
      deploymentNamespace: room.deploymentNamespace ?? this.options.deploymentNamespace,
      revision: room.roomRevision ?? 1,
      operationId: `lifecycle:${randomUUID()}`,
      roomCode: room.code,
      roomId: room.id,
      kind,
      credentialRef,
      terminal: false,
      attempts: 0,
      nextRetryAt: this.now(),
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    await this.outbox.put(intent);
    const completed = await this.process(intent);
    return { operationId: intent.operationId, committed: true, cleanupPending: !completed };
  }

  /** Cleanup for a credential created before its room attach commit. */
  async enqueueOrphanCredentialCleanup(
    roomCode: string,
    roomId: string,
    credentialRef: string,
  ): Promise<LifecycleCommitResult> {
    const intent: LifecycleIntent = {
      schemaVersion: 1,
      environment: this.options.environment,
      deploymentNamespace: this.options.deploymentNamespace,
      revision: 0,
      operationId: `lifecycle:${randomUUID()}`,
      roomCode: roomCode.trim().toUpperCase(),
      roomId,
      kind: 'mode_switch',
      credentialRef,
      terminal: false,
      attempts: 0,
      nextRetryAt: this.now(),
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    await this.outbox.put(intent);
    const completed = await this.process(intent);
    return { operationId: intent.operationId, committed: true, cleanupPending: !completed };
  }

  async restore(): Promise<number> {
    // The room and outbox are separate durable adapters. If the process died
    // after the tombstone write but before outbox.put, reconstruct the intent
    // from the tombstone so cleanup cannot be stranded at that boundary.
    const knownOperationIds = new Set(
      (await this.outbox.listPending(Number.MAX_SAFE_INTEGER))
        .map((intent) => intent.operationId),
    );
    for (const room of await this.repository.list()) {
      const tombstone = room.lifecycleTombstone;
      if (!tombstone || knownOperationIds.has(tombstone.operationId)) continue;
      if (!this.isTerminalKind(tombstone.kind)) continue;
      await this.outbox.put({
        schemaVersion: 1,
        environment: tombstone.environment,
        deploymentNamespace: tombstone.deploymentNamespace,
        revision: room.roomRevision ?? 1,
        operationId: tombstone.operationId,
        roomCode: room.code,
        roomId: room.id,
        kind: tombstone.kind,
        terminal: true,
        ...(tombstone.credentialRef ? { credentialRef: tombstone.credentialRef } : {}),
        attempts: 0,
        nextRetryAt: this.now(),
        createdAt: tombstone.closedAt,
        updatedAt: this.now(),
      });
    }
    let completed = 0;
    for (const intent of await this.outbox.listPending(this.now())) {
      if (await this.process(intent)) completed += 1;
    }
    return completed;
  }

  async retryPending(): Promise<number> {
    return this.restore();
  }

  async pending(): Promise<LifecycleIntent[]> {
    return this.outbox.listPending(Number.MAX_SAFE_INTEGER);
  }

  private isTerminalKind(value: string): value is Exclude<RoomLifecycleKind, 'mode_switch'> {
    return value === 'last_member_leave' || value === 'dissolve' ||
      value === 'waiting_ttl' || value === 'ended_retention' || value === 'admin_remove';
  }

  private key(roomCode: string, commandId: string): string {
    return `${roomCode.toUpperCase()}:${commandId}`;
  }

  private async process(intent: LifecycleIntent): Promise<boolean> {
    const room = await this.repository.get(intent.roomCode);
    try {
      if (this.options.credentialStore && intent.credentialRef) {
        await this.options.credentialStore.delete(
          { namespace: this.options.credentialNamespace ?? intent.deploymentNamespace, roomCode: intent.roomCode },
          intent.credentialRef,
        );
      }
      await this.options.onCleanup?.(room ? clone(room) : undefined, clone(intent));
      if (intent.terminal && room) await this.repository.remove(intent.roomCode);
      await this.outbox.complete(intent.operationId);
      return true;
    } catch (error) {
      const attempts = intent.attempts + 1;
      await this.outbox.update({
        ...intent,
        attempts,
        nextRetryAt: this.now() + Math.min(60_000, this.retryBaseMs * 2 ** Math.min(attempts, 6)),
        updatedAt: this.now(),
        lastErrorCode: safeErrorCode(error),
      });
      return false;
    }
  }
}
