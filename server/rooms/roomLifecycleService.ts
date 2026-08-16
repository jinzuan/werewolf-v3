import type { CommandReceipt, RoomView } from '../../shared/protocol';

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

/**
 * The seam between room facts and lifecycle side effects. C-05 can replace
 * the in-memory indexes with its durable tombstone/outbox adapter without
 * changing command transport or client reconciliation.
 */
export class RoomLifecycleService {
  private readonly receipts = new Map<string, CommandReceipt>();
  private readonly tombstones = new Map<string, RoomTombstone>();

  rememberReceipt(receipt: CommandReceipt): CommandReceipt {
    const stored = structuredClone(receipt);
    this.receipts.set(this.key(receipt.roomCode, receipt.commandId), stored);
    return structuredClone(stored);
  }

  rememberTombstone(tombstone: RoomTombstone): RoomTombstone {
    const stored = structuredClone(tombstone);
    this.tombstones.set(stored.roomCode.toUpperCase(), stored);
    return structuredClone(stored);
  }

  getReceipt(roomCode: string, commandId: string): CommandReceipt | undefined {
    const receipt = this.receipts.get(this.key(roomCode, commandId));
    return receipt ? structuredClone(receipt) : undefined;
  }

  getTombstone(roomCode: string): RoomTombstone | undefined {
    const tombstone = this.tombstones.get(roomCode.toUpperCase());
    return tombstone ? structuredClone(tombstone) : undefined;
  }

  clear(roomCode: string): void {
    const prefix = `${roomCode.toUpperCase()}:`;
    for (const key of this.receipts.keys()) {
      if (key.startsWith(prefix)) this.receipts.delete(key);
    }
    this.tombstones.delete(roomCode.toUpperCase());
  }

  private key(roomCode: string, commandId: string): string {
    return `${roomCode.toUpperCase()}:${commandId}`;
  }
}
