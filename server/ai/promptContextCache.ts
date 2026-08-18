import type { DomainEvent, ViewerContext } from '../../shared/events';
import type { GameSession } from '../session/gameSession';

export interface PromptContextCacheEntry {
  gameId: string;
  viewerKey: string;
  afterSequence: number;
  events: DomainEvent[];
  reads: number;
  droppedEvents: number;
}

const viewerKey = (viewer: ViewerContext): string =>
  viewer.kind === 'player'
    ? `player:${viewer.playerId}:${viewer.role}:${viewer.isAlive === undefined ? 'unknown' : viewer.isAlive ? 'alive' : 'dead'}:${viewer.deathCutoffSequence ?? 'none'}`
    : `spectator:${viewer.spectatorId}:${viewer.omniscient ? 'omniscient' : 'public'}`;

const clone = <T>(value: T): T => structuredClone(value);

/**
 * Incremental event projection for AI prompts.
 *
 * The cache is deliberately scoped to one application lifetime.  It only
 * stores already projected events, so a later viewer can never observe a
 * private event from another viewer's cache entry.
 */
export class PromptContextCache {
  private readonly entries = new Map<string, PromptContextCacheEntry>();

  async eventsFor(
    session: GameSession,
    viewer: ViewerContext,
  ): Promise<DomainEvent[]> {
    const key = `${session.gameId}:${viewerKey(viewer)}`;
    const current = this.entries.get(key);
    const afterSequence = current?.afterSequence ?? 0;
    const delta = await session.eventsFor(viewer, afterSequence);
    const merged = [...(current?.events ?? []), ...delta];
    const deduped = [...new Map(merged.map((event) => [event.eventId, event])).values()]
      .sort((left, right) => left.sequence - right.sequence);
    const next: PromptContextCacheEntry = {
      gameId: session.gameId,
      viewerKey: key,
      afterSequence: session.sequence,
      events: deduped,
      reads: (current?.reads ?? 0) + 1,
      droppedEvents: current?.droppedEvents ?? 0,
    };
    this.entries.set(key, next);
    return clone(deduped);
  }

  stats(gameId?: string): PromptContextCacheEntry[] {
    return clone(
      [...this.entries.values()].filter((entry) => !gameId || entry.gameId === gameId),
    );
  }

  clearGame(gameId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.gameId === gameId) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
