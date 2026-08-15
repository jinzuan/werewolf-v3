import path from 'node:path';
import {
  atomicWriteFile,
  assertSecurePath,
  readSecureFile,
  type AsyncAtomicWriteOptions,
} from '../filePersistence';
import type { ReviewRepository, ReviewJobRecord } from './reviewRepository';

const clone = <T>(value: T): T => structuredClone(value);

export class FileReviewRepository implements ReviewRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private jobs?: ReviewJobRecord[];
  private readonly persistence: AsyncAtomicWriteOptions;
  private readonly dataRoot: string;

  constructor(
    private readonly filePath = path.resolve(process.cwd(), 'server', 'data', 'v3-reviews.json'),
    persistence: AsyncAtomicWriteOptions = {},
  ) {
    if (!path.isAbsolute(filePath)) {
      throw new TypeError('FileReviewRepository requires an absolute file path.');
    }
    this.dataRoot = persistence.dataRoot ?? path.dirname(filePath);
    assertSecurePath(filePath, this.dataRoot);
    this.persistence = {
      ...persistence,
      dataRoot: this.dataRoot,
    };
  }

  list(): Promise<ReviewJobRecord[]> {
    return this.enqueue(async () => clone(await this.load()));
  }

  get(gameId: string): Promise<ReviewJobRecord | undefined> {
    return this.enqueue(async () => {
      const job = (await this.load()).find((item) => item.gameId === gameId);
      return job ? clone(job) : undefined;
    });
  }

  createPending(
    input: Parameters<ReviewRepository['createPending']>[0],
  ): Promise<{ job: ReviewJobRecord; created: boolean }> {
    return this.enqueue(async () => {
      const jobs = await this.load();
      const existing = jobs.find((item) => item.gameId === input.gameId);
      if (existing) return { job: clone(existing), created: false };
      const now = Date.now();
      const job: ReviewJobRecord = {
        ...clone(input),
        status: 'pending',
        messages: clone(input.messages ?? []),
        insights: clone(input.insights ?? []),
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      jobs.push(job);
      this.jobs = jobs;
      await this.write(jobs);
      return { job: clone(job), created: true };
    });
  }

  save(job: ReviewJobRecord): Promise<ReviewJobRecord> {
    return this.enqueue(async () => {
      const jobs = await this.load();
      const next = clone({ ...job, updatedAt: Date.now() });
      const index = jobs.findIndex((item) => item.gameId === next.gameId);
      if (index === -1) jobs.push(next);
      else jobs[index] = next;
      this.jobs = jobs;
      await this.write(jobs);
      return clone(next);
    });
  }

  private async load(): Promise<ReviewJobRecord[]> {
    if (this.jobs) return this.jobs;
    try {
      const parsed = JSON.parse(await readSecureFile(this.filePath, {
        dataRoot: this.dataRoot,
        maxBytes: this.persistence.maxBytes,
      })) as unknown;
      this.jobs = Array.isArray(parsed) ? parsed as ReviewJobRecord[] : [];
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        (error as NodeJS.ErrnoException).code !== 'ENOENT'
      ) throw error;
      this.jobs = [];
    }
    return this.jobs;
  }

  private async write(jobs: ReviewJobRecord[]): Promise<void> {
    await atomicWriteFile(this.filePath, () => JSON.stringify(jobs, null, 2), this.persistence);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
