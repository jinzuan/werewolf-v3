import type {
  EventAppendRequest,
  EventStore,
  StoredEvent,
} from '../../shared/events';

export class EventVersionConflictError extends Error {
  constructor(
    readonly streamId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Event stream ${streamId} expected version ${expectedVersion}, actual ${actualVersion}.`,
    );
  }
}

export class InMemoryEventStore implements EventStore {
  private readonly streams = new Map<string, StoredEvent[]>();

  async append(request: EventAppendRequest): Promise<StoredEvent[]> {
    const current = this.streams.get(request.streamId) ?? [];
    if (current.length !== request.expectedVersion) {
      throw new EventVersionConflictError(
        request.streamId,
        request.expectedVersion,
        current.length,
      );
    }

    const stored = request.events.map((event, index) => ({
      streamId: request.streamId,
      streamVersion: current.length + index + 1,
      event,
    }));
    this.streams.set(request.streamId, [...current, ...stored]);
    return stored;
  }

  async read(streamId: string, afterSequence = 0): Promise<StoredEvent[]> {
    return (this.streams.get(streamId) ?? []).filter(
      ({ event }) => event.sequence > afterSequence,
    );
  }

  async remove(streamId: string): Promise<void> {
    this.streams.delete(streamId);
  }

  exportStreams(): Record<string, StoredEvent[]> {
    return Object.fromEntries(
      [...this.streams.entries()].map(([streamId, events]) => [
        streamId,
        structuredClone(events),
      ]),
    );
  }

  importStreams(streams: Record<string, StoredEvent[]>): void {
    this.streams.clear();
    for (const [streamId, events] of Object.entries(streams)) {
      this.streams.set(streamId, structuredClone(events));
    }
  }
}
