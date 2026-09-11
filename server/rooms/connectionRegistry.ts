import { randomUUID } from 'node:crypto';

/**
 * A connection is a process fact, never a room fact.  The registry is kept
 * deliberately small so it can be rebuilt from zero after a restart.
 */
export class ConnectionRegistry {
  readonly processEpoch: string;
  private readonly connections = new Map<string, Set<string>>();
  private readonly serviceConnections = new Map<string, string>();

  constructor(processEpoch: string = randomUUID()) {
    this.processEpoch = processEpoch;
  }

  private key(roomCode: string, memberId: string): string {
    return `${roomCode.trim().toUpperCase()}:${memberId}`;
  }

  /** Bind a physical socket. Rebinding the same socket is idempotent. */
  bind(roomCode: string, memberId: string, connectionId: string): void {
    const key = this.key(roomCode, memberId);
    const serviceConnection = this.serviceConnections.get(key);
    if (serviceConnection) {
      this.unbind(roomCode, memberId, serviceConnection);
      this.serviceConnections.delete(key);
    }
    const set = this.connections.get(key) ?? new Set<string>();
    set.add(connectionId);
    this.connections.set(key, set);
  }

  bindConnection(roomCode: string, memberId: string, connectionId: string): void {
    this.bind(roomCode, memberId, connectionId);
  }

  /** Direct service calls have no socket yet; this is still process-local. */
  markServiceConnected(roomCode: string, memberId: string): void {
    const key = this.key(roomCode, memberId);
    if (this.isConnected(roomCode, memberId)) return;
    const connectionId = `service:${this.processEpoch}:${memberId}`;
    this.serviceConnections.set(key, connectionId);
    const set = this.connections.get(key) ?? new Set<string>();
    set.add(connectionId);
    this.connections.set(key, set);
  }

  /** Remove exactly one lease. A stale socket cannot take another tab offline. */
  unbind(roomCode: string, memberId: string, connectionId?: string): boolean {
    const key = this.key(roomCode, memberId);
    const set = this.connections.get(key);
    if (!set) return false;
    if (connectionId === undefined) set.clear();
    else {
      const synthetic = this.serviceConnections.get(key);
      const hasPhysicalLease = [...set].some((lease) => lease !== synthetic);
      const removed = set.delete(connectionId);
      // Direct service callers historically supplied a transport id without
      // a preceding bind. Retire that synthetic lease only when no physical
      // tab exists; a stale socket id must never affect another live tab.
      if (!removed && synthetic && !hasPhysicalLease) {
        set.delete(synthetic);
        this.serviceConnections.delete(key);
      }
    }
    if (this.serviceConnections.get(key) === connectionId) {
      this.serviceConnections.delete(key);
    }
    if (set.size === 0) this.connections.delete(key);
    return true;
  }

  unbindConnection(roomCode: string, memberId: string, connectionId?: string): boolean {
    return this.unbind(roomCode, memberId, connectionId);
  }

  isConnected(roomCode: string, memberId: string): boolean {
    return (this.connections.get(this.key(roomCode, memberId))?.size ?? 0) > 0;
  }

  onlineMemberIds(roomCode: string): Set<string> {
    const prefix = `${roomCode.trim().toUpperCase()}:`;
    return new Set(
      [...this.connections.entries()]
        .filter(([, connections]) => connections.size > 0)
        .map(([key]) => key.startsWith(prefix) ? key.slice(prefix.length) : '')
        .filter(Boolean),
    );
  }

  connectionCount(roomCode: string, memberId: string): number {
    return this.connections.get(this.key(roomCode, memberId))?.size ?? 0;
  }

  clearRoom(roomCode: string): void {
    const prefix = `${roomCode.trim().toUpperCase()}:`;
    for (const key of [...this.connections.keys()]) {
      if (key.startsWith(prefix)) {
        this.connections.delete(key);
        this.serviceConnections.delete(key);
      }
    }
  }

  clear(): void {
    this.connections.clear();
    this.serviceConnections.clear();
  }

  /** Useful for restart tests: persisted online bits must never be imported. */
  restore(_roomCodes: readonly string[] = []): void {
    this.clear();
  }

  snapshot(roomCode: string): Record<string, number> {
    const prefix = `${roomCode.trim().toUpperCase()}:`;
    return Object.fromEntries(
      [...this.connections.entries()]
        .filter(([key, set]) => key.startsWith(prefix) && set.size > 0)
        .map(([key, set]) => [key.slice(prefix.length), set.size]),
    );
  }
}

export const createConnectionRegistry = (processEpoch?: string): ConnectionRegistry =>
  new ConnectionRegistry(processEpoch ?? randomUUID());
