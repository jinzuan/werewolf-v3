import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import type {
  EventAppendRequest,
  EventStore,
  StoredEvent,
} from '../../shared/events';
import {
  atomicWriteFile,
  assertSecurePath,
  readSecureFile,
  secureFileStats,
  type AsyncAtomicWriteOptions,
  withFileLock,
} from '../filePersistence';
import { EventVersionConflictError } from './store';
import type { RuntimeEnvironment } from '../runtimeConfig';

export const EVENT_FILE_SCHEMA_VERSION = 1;
type PersistedStreams = Record<string, StoredEvent[]>;

interface EventFileDocument {
  schemaVersion: number;
  environment: RuntimeEnvironment;
  deploymentNamespace: string;
  streams: PersistedStreams;
}

export class FileEventStoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'DATA_NAMESPACE_MISMATCH'
      | 'DATA_ENVIRONMENT_MISMATCH'
      | 'DATA_SCHEMA_UNSUPPORTED'
      | 'DATA_FILE_INVALID',
  ) {
    super(message);
    this.name = 'FileEventStoreError';
  }
}
export interface FileEventStoreOptions extends AsyncAtomicWriteOptions {
  environment?: RuntimeEnvironment;
  deploymentNamespace?: string;
  namespace?: string;
}

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  (error as NodeJS.ErrnoException).code === 'ENOENT';

const fileRevision = async (
  file: string,
  dataRoot: string,
): Promise<string | undefined> => {
  try {
    const details = await secureFileStats(file, { dataRoot });
    return `${details.dev}:${details.ino}:${details.size}:${details.mtimeMs}:${details.ctimeMs}`;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
};

export class FileEventStore implements EventStore {
  private queue: Promise<unknown> = Promise.resolve();
  private streams?: PersistedStreams;
  private diskRevision?: string;
  private dirty = false;
  readonly environment: RuntimeEnvironment;
  readonly deploymentNamespace: string;
  private readonly persistence: AsyncAtomicWriteOptions;
  private readonly dataRoot: string;

  constructor(
    readonly filePath: string,
    options: FileEventStoreOptions = {},
  ) {
    if (!path.isAbsolute(filePath)) {
      throw new TypeError('FileEventStore requires an absolute file path.');
    }
    this.dataRoot = options.dataRoot ?? path.dirname(filePath);
    assertSecurePath(filePath, this.dataRoot);
    this.environment = options.environment ?? 'development';
    this.deploymentNamespace =
      options.deploymentNamespace ?? options.namespace ?? 'default';
    this.persistence = {
      operations: options.operations,
      sleep: options.sleep,
      logger: options.logger,
      dataRoot: this.dataRoot,
      maxBytes: options.maxBytes,
    };
  }

  append(request: EventAppendRequest): Promise<StoredEvent[]> {
    const run = this.queue.then(() =>
      withFileLock(this.filePath, async () => {
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
      }),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  read(streamId: string, afterSequence = 0): Promise<StoredEvent[]> {
    const run = this.queue.then(() =>
      withFileLock(this.filePath, async () =>
        ((await this.load())[streamId] ?? []).filter(
          ({ event }) => event.sequence > afterSequence,
        ),
      ),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<PersistedStreams> {
    const revision = await fileRevision(this.filePath, this.dataRoot);
    if (this.streams && revision === this.diskRevision) return this.streams;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readSecureFile(this.filePath, {
        dataRoot: this.dataRoot,
        maxBytes: this.persistence.maxBytes,
      }));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.streams = {};
      this.diskRevision = undefined;
      this.dirty = false;
      return this.streams;
    }

    const source = this.parseDocument(parsed);
    this.streams = source;
    this.diskRevision = revision;
    this.dirty = false;
    if (!this.isCurrentDocument(parsed, source)) await this.write(source);
    return this.streams;
  }

  private parseDocument(value: unknown): PersistedStreams {
    // Import old event files only through the explicitly configured namespace,
    // then rewrite them with a provenance header in the same controlled turn.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const document = value as Partial<EventFileDocument> & {
        streams?: unknown;
      };
      if (document.schemaVersion !== EVENT_FILE_SCHEMA_VERSION) {
        throw new FileEventStoreError(
          'Unsupported event data schema.',
          'DATA_SCHEMA_UNSUPPORTED',
        );
      }
      if (document.deploymentNamespace !== this.deploymentNamespace) {
        throw new FileEventStoreError(
          'Event data belongs to another deployment namespace.',
          'DATA_NAMESPACE_MISMATCH',
        );
      }
      if (document.environment && document.environment !== this.environment) {
        throw new FileEventStoreError(
          'Event data belongs to another runtime environment.',
          'DATA_ENVIRONMENT_MISMATCH',
        );
      }
      if (!document.streams || typeof document.streams !== 'object') {
        throw new FileEventStoreError(
          'Event data document has no streams object.',
          'DATA_FILE_INVALID',
        );
      }
      return document.streams as PersistedStreams;
    }
    if (!value || typeof value !== 'object') {
      throw new FileEventStoreError(
        'Event data file is not a JSON event document.',
        'DATA_FILE_INVALID',
      );
    }
    return value as PersistedStreams;
  }

  private isCurrentDocument(value: unknown, streams: PersistedStreams): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const document = value as Partial<EventFileDocument>;
    return (
      document.schemaVersion === EVENT_FILE_SCHEMA_VERSION &&
      document.environment === this.environment &&
      document.deploymentNamespace === this.deploymentNamespace &&
      isDeepStrictEqual(document.streams, streams)
    );
  }

  private async write(streams: PersistedStreams): Promise<void> {
    const document: EventFileDocument = {
      schemaVersion: EVENT_FILE_SCHEMA_VERSION,
      environment: this.environment,
      deploymentNamespace: this.deploymentNamespace,
      streams,
    };
    const persisted = await atomicWriteFile(
      this.filePath,
      () => JSON.stringify(document, null, 2),
      this.persistence,
    );
    if (persisted) {
      this.diskRevision = await fileRevision(this.filePath, this.dataRoot);
      this.dirty = false;
    } else {
      this.dirty = true;
    }
  }
}
