import path from 'node:path';
import type { Role } from '../../shared/types';
import {
  atomicWriteFile,
  assertSecurePath,
  readSecureFile,
  type AsyncAtomicWriteOptions,
  withFileLock,
} from '../filePersistence';

export const INSIGHT_SCHEMA_VERSION = 2 as const;
export const MAX_INSIGHTS_PER_ROLE = 8;

export interface ServerInsightRecord {
  id: string;
  role: Role;
  text: string;
  evidenceEventIds: string[];
  gameId: string;
  createdAt: number;
  schemaVersion: typeof INSIGHT_SCHEMA_VERSION;
  /** Shared is the legacy role pool; agent records belong to one AI instance. */
  scope?: 'shared' | 'agent';
  playerId?: string;
  experienceInstanceId?: string;
}

export interface InsightStore {
  list(role?: Role, playerId?: string): Promise<ServerInsightRecord[]>;
  add(record: ServerInsightRecord): Promise<{ record: ServerInsightRecord; added: boolean }>;
  clear(role?: Role, playerId?: string): Promise<void>;
  getPromptReference(role: Role, playerId?: string, experienceInstanceId?: string): Promise<string>;
}

const clone = <T>(value: T): T => structuredClone(value);
const similarity = (left: string, right: string): number => {
  const a = new Set(left);
  const b = new Set(right);
  const intersection = [...a].filter((item) => b.has(item)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
};

const scopeOf = (record: ServerInsightRecord): 'shared' | 'agent' =>
  record.scope === 'agent' || record.playerId ? 'agent' : 'shared';

const belongsTo = (
  record: ServerInsightRecord,
  role?: Role,
  playerId?: string,
  experienceInstanceId?: string,
): boolean => {
  if (role && record.role !== role) return false;
  if (playerId && (record.playerId !== playerId || scopeOf(record) !== 'agent')) return false;
  if (experienceInstanceId && record.experienceInstanceId !== experienceInstanceId) return false;
  return true;
};

const retentionKey = (record: ServerInsightRecord): string =>
  `${scopeOf(record)}:${record.role}:${record.playerId ?? ''}:${record.experienceInstanceId ?? ''}`;

export class InMemoryInsightStore implements InsightStore {
  private records: ServerInsightRecord[] = [];

  async list(role?: Role, playerId?: string): Promise<ServerInsightRecord[]> {
    return clone(this.records.filter((item) => belongsTo(item, role, playerId)));
  }

  async add(record: ServerInsightRecord): Promise<{ record: ServerInsightRecord; added: boolean }> {
    const sameGame = this.records.find((item) =>
      item.gameId === record.gameId && retentionKey(item) === retentionKey(record));
    if (sameGame) return { record: clone(sameGame), added: false };
    const sameScope = this.records.filter((item) => retentionKey(item) === retentionKey(record));
    if (sameScope.some((item) => similarity(item.text, record.text) >= 0.6)) {
      return { record: clone(record), added: false };
    }
    // Keep insertion order while enforcing the per-role retention cap.
    const byRole = new Map<string, ServerInsightRecord[]>();
    for (const item of [...this.records, clone(record)]) {
      const list = byRole.get(retentionKey(item)) ?? [];
      list.push(item);
      byRole.set(retentionKey(item), list.slice(-MAX_INSIGHTS_PER_ROLE));
    }
    this.records = [...byRole.values()].flat();
    return { record: clone(record), added: true };
  }

  async clear(role?: Role, playerId?: string): Promise<void> {
    this.records = role || playerId
      ? this.records.filter((item) => !belongsTo(item, role, playerId))
      : [];
  }

  async getPromptReference(role: Role, playerId?: string, experienceInstanceId?: string): Promise<string> {
    const records = (await this.list(role)).filter((item) =>
      scopeOf(item) === 'shared' ||
      (item.playerId === playerId && item.experienceInstanceId === experienceInstanceId),
    );
    if (records.length === 0) return '';
    return [
      '【历史经验，非本局事实】',
      ...records.map((item) => `- ${item.text}`),
    ].join('\n');
  }
}

export class FileInsightStore implements InsightStore {
  private queue: Promise<unknown> = Promise.resolve();
  private records?: ServerInsightRecord[];
  private readonly persistence: AsyncAtomicWriteOptions;
  private readonly dataRoot: string;

  constructor(
    private readonly filePath = path.resolve(process.cwd(), 'server', 'data', 'v3-insights.json'),
    persistence: AsyncAtomicWriteOptions = {},
  ) {
    if (!path.isAbsolute(filePath)) {
      throw new TypeError('FileInsightStore requires an absolute file path.');
    }
    this.dataRoot = persistence.dataRoot ?? path.dirname(filePath);
    assertSecurePath(filePath, this.dataRoot);
    this.persistence = {
      ...persistence,
      dataRoot: this.dataRoot,
    };
  }

  list(role?: Role, playerId?: string): Promise<ServerInsightRecord[]> {
    return this.enqueue(() => withFileLock(this.filePath, async () => {
      const records = await this.load();
      return clone(records.filter((item) => belongsTo(item, role, playerId)));
    }));
  }

  add(record: ServerInsightRecord): Promise<{ record: ServerInsightRecord; added: boolean }> {
    return this.enqueue(() => withFileLock(this.filePath, async () => {
      const records = await this.load();
      const sameGame = records.find((item) =>
        item.gameId === record.gameId && retentionKey(item) === retentionKey(record));
      if (sameGame) return { record: clone(sameGame), added: false };
      const sameScope = records.filter((item) => retentionKey(item) === retentionKey(record));
      if (sameScope.some((item) => similarity(item.text, record.text) >= 0.6)) {
        return { record: clone(record), added: false };
      }
      const next = [...records, clone(record)];
      const byRole = new Map<string, ServerInsightRecord[]>();
      for (const item of next) {
        const list = byRole.get(retentionKey(item)) ?? [];
        list.push(item);
        byRole.set(retentionKey(item), list.slice(-MAX_INSIGHTS_PER_ROLE));
      }
      const nextRecords = [...byRole.values()].flat();
      await this.write(nextRecords);
      this.records = nextRecords;
      return { record: clone(record), added: true };
    }));
  }

  clear(role?: Role, playerId?: string): Promise<void> {
    return this.enqueue(() => withFileLock(this.filePath, async () => {
      const records = await this.load();
      const nextRecords = role || playerId
        ? records.filter((item) => !belongsTo(item, role, playerId))
        : [];
      await this.write(nextRecords);
      this.records = nextRecords;
    }));
  }

  getPromptReference(role: Role, playerId?: string, experienceInstanceId?: string): Promise<string> {
    return this.enqueue(() => withFileLock(this.filePath, async () => {
      const records = (await this.load()).filter((item) =>
        item.role === role && (
          scopeOf(item) === 'shared' ||
          (item.playerId === playerId && item.experienceInstanceId === experienceInstanceId)
        ),
      );
      if (records.length === 0) return '';
      return [
        '【历史经验，非本局事实】',
        ...records.map((item) => `- ${item.text}`),
      ].join('\n');
    }));
  }

  private async load(): Promise<ServerInsightRecord[]> {
    if (this.records) return this.records;
    try {
      const parsed = JSON.parse(await readSecureFile(this.filePath, {
        dataRoot: this.dataRoot,
        maxBytes: this.persistence.maxBytes,
      })) as unknown;
      this.records = Array.isArray(parsed) ? parsed as ServerInsightRecord[] : [];
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        (error as NodeJS.ErrnoException).code !== 'ENOENT'
      ) throw error;
      this.records = [];
    }
    return this.records;
  }

  private async write(records: ServerInsightRecord[]): Promise<void> {
    await atomicWriteFile(this.filePath, () => JSON.stringify(records, null, 2), this.persistence);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
