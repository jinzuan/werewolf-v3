import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, ensureSecureDirectory } from '../filePersistence';
import type { RuntimeEnvironment } from '../runtimeConfig';

export const LIFECYCLE_OUTBOX_SCHEMA_VERSION = 1;

export type RoomLifecycleKind =
  | 'last_member_leave'
  | 'dissolve'
  | 'waiting_ttl'
  | 'ended_retention'
  | 'mode_switch'
  | 'admin_remove';

export interface LifecycleIntent {
  schemaVersion: number;
  environment: RuntimeEnvironment;
  deploymentNamespace: string;
  revision: number;
  operationId: string;
  roomCode: string;
  roomId: string;
  kind: RoomLifecycleKind;
  credentialRef?: string;
  terminal: boolean;
  attempts: number;
  nextRetryAt: number;
  createdAt: number;
  updatedAt: number;
  lastErrorCode?: string;
}

export interface LifecycleOutboxDocument {
  schemaVersion: number;
  environment: RuntimeEnvironment;
  deploymentNamespace: string;
  revision: number;
  intents: Record<string, LifecycleIntent>;
}

export interface LifecycleOutbox {
  listPending(now: number): Promise<LifecycleIntent[]>;
  put(intent: LifecycleIntent): Promise<void>;
  update(intent: LifecycleIntent): Promise<void>;
  complete(operationId: string): Promise<void>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryLifecycleOutbox implements LifecycleOutbox {
  private readonly intents = new Map<string, LifecycleIntent>();

  async listPending(now: number): Promise<LifecycleIntent[]> {
    return [...this.intents.values()]
      .filter((intent) => intent.nextRetryAt <= now)
      .map(clone);
  }

  async put(intent: LifecycleIntent): Promise<void> {
    const existing = this.intents.get(intent.operationId);
    this.intents.set(intent.operationId, clone(existing ?? intent));
  }

  async update(intent: LifecycleIntent): Promise<void> {
    this.intents.set(intent.operationId, clone(intent));
  }

  async complete(operationId: string): Promise<void> {
    this.intents.delete(operationId);
  }

  async list(): Promise<LifecycleIntent[]> {
    return [...this.intents.values()].map(clone);
  }
}

export interface FileLifecycleOutboxOptions {
  dataRoot?: string;
  environment: RuntimeEnvironment;
  deploymentNamespace: string;
  maxBytes?: number;
}

/** One document per deployment namespace; mutations are serialized in-process. */
export class FileLifecycleOutbox implements LifecycleOutbox {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly dataRoot: string;
  private readonly maxBytes: number;

  constructor(
    private readonly filePath: string,
    private readonly options: FileLifecycleOutboxOptions,
  ) {
    if (!path.isAbsolute(filePath)) throw new Error('lifecycle outbox path must be absolute');
    this.dataRoot = options.dataRoot ?? path.dirname(filePath);
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  }

  async listPending(now: number): Promise<LifecycleIntent[]> {
    return this.enqueue(async () => {
      const document = await this.load();
      return Object.values(document.intents)
        .filter((intent) => intent.nextRetryAt <= now)
        .map(clone);
    });
  }

  async put(intent: LifecycleIntent): Promise<void> {
    await this.enqueue(async () => {
      const document = await this.load();
      if (!document.intents[intent.operationId]) {
        document.intents[intent.operationId] = clone(intent);
        document.revision += 1;
        await this.save(document);
      }
    });
  }

  async update(intent: LifecycleIntent): Promise<void> {
    await this.enqueue(async () => {
      const document = await this.load();
      document.intents[intent.operationId] = clone(intent);
      document.revision += 1;
      await this.save(document);
    });
  }

  async complete(operationId: string): Promise<void> {
    await this.enqueue(async () => {
      const document = await this.load();
      if (!document.intents[operationId]) return;
      delete document.intents[operationId];
      document.revision += 1;
      await this.save(document);
    });
  }

  private async load(): Promise<LifecycleOutboxDocument> {
    await ensureSecureDirectory(path.dirname(this.filePath), { dataRoot: this.dataRoot });
    try {
      const text = await readFile(this.filePath, { encoding: 'utf8' });
      if (Buffer.byteLength(text, 'utf8') > this.maxBytes) throw new Error('lifecycle outbox exceeds size limit');
      const parsed = JSON.parse(text) as LifecycleOutboxDocument;
      if (
        parsed.schemaVersion !== LIFECYCLE_OUTBOX_SCHEMA_VERSION ||
        parsed.environment !== this.options.environment ||
        parsed.deploymentNamespace !== this.options.deploymentNamespace ||
        !parsed.intents || typeof parsed.intents !== 'object'
      ) throw new Error('lifecycle outbox header is invalid');
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          schemaVersion: LIFECYCLE_OUTBOX_SCHEMA_VERSION,
          environment: this.options.environment,
          deploymentNamespace: this.options.deploymentNamespace,
          revision: 0,
          intents: {},
        };
      }
      throw new Error('lifecycle outbox is unreadable');
    }
  }

  private async save(document: LifecycleOutboxDocument): Promise<void> {
    const saved = await atomicWriteFile(this.filePath, () => JSON.stringify(document, null, 2), {
      dataRoot: this.dataRoot,
      maxBytes: this.maxBytes,
    });
    if (!saved) throw new Error('lifecycle outbox write failed');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export const lifecycleOperationId = (): string => `lifecycle:${randomUUID()}`;
