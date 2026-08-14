import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  EventAppendRequest,
  EventStore,
  StoredEvent,
} from '../../shared/events';
import {
  atomicWriteFile,
  type AsyncAtomicWriteOptions,
} from '../filePersistence';
import { EventVersionConflictError } from './store';

type PersistedStreams = Record<string, StoredEvent[]>;

export class FileEventStore implements EventStore {
  private queue: Promise<unknown> = Promise.resolve();
  private streams?: PersistedStreams;

  constructor(
    private readonly filePath = path.resolve(
      process.cwd(),
      'server',
      'data',
      'v3-events.json',
    ),
    private readonly persistence: AsyncAtomicWriteOptions = {},
  ) {}

  append(request: EventAppendRequest): Promise<StoredEvent[]> {
    const run = this.queue.then(async () => {
      const streams = await this.load();
      const current = streams[request.streamId] ?? [];
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
      const next = {
        ...streams,
        [request.streamId]: [...current, ...stored],
      };
      this.streams = next;
      await this.write(next);
      return stored;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  read(streamId: string, afterSequence = 0): Promise<StoredEvent[]> {
    const run = this.queue.then(async () =>
      ((await this.load())[streamId] ?? []).filter(
        ({ event }) => event.sequence > afterSequence,
      ),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<PersistedStreams> {
    if (this.streams) return this.streams;
    try {
      this.streams = JSON.parse(
        await readFile(this.filePath, 'utf8'),
      ) as PersistedStreams;
    } catch {
      this.streams = {};
    }
    return this.streams;
  }

  private async write(streams: PersistedStreams): Promise<void> {
    await atomicWriteFile(
      this.filePath,
      () => JSON.stringify(streams, null, 2),
      this.persistence,
    );
  }
}
