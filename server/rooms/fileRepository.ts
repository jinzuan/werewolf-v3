import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  atomicWriteFile,
  type AsyncAtomicWriteOptions,
} from '../filePersistence';
import type { RoomRecord } from './types';
import type { RoomRepository } from './repository';

export class FileRoomRepository implements RoomRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private rooms?: RoomRecord[];

  constructor(
    private readonly filePath = path.resolve(
      process.cwd(),
      'server',
      'data',
      'v3-rooms.json',
    ),
    private readonly persistence: AsyncAtomicWriteOptions = {},
  ) {}

  list(): Promise<RoomRecord[]> {
    return this.enqueue(async () =>
      structuredClone(await this.load()),
    );
  }

  get(code: string): Promise<RoomRecord | undefined> {
    return this.enqueue(async () => {
      const room = (await this.load()).find(
        (item) => item.code === code.toUpperCase(),
      );
      return room ? structuredClone(room) : undefined;
    });
  }

  save(room: RoomRecord): Promise<void> {
    return this.enqueue(async () => {
      const rooms = (await this.load()).filter(
        (item) => item.code !== room.code,
      );
      rooms.push(structuredClone(room));
      this.rooms = rooms;
      await this.write(rooms);
    });
  }

  remove(code: string): Promise<void> {
    return this.enqueue(async () => {
      const rooms = (await this.load()).filter(
        (room) => room.code !== code.toUpperCase(),
      );
      this.rooms = rooms;
      await this.write(rooms);
    });
  }

  private async load(): Promise<RoomRecord[]> {
    if (this.rooms) return this.rooms;
    try {
      this.rooms = JSON.parse(
        await readFile(this.filePath, 'utf8'),
      ) as RoomRecord[];
    } catch {
      this.rooms = [];
    }
    return this.rooms;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(rooms: RoomRecord[]): Promise<void> {
    await atomicWriteFile(
      this.filePath,
      () => JSON.stringify(rooms, null, 2),
      this.persistence,
    );
  }
}
