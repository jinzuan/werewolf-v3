import type { RoomRecord } from './types';

export interface RoomRepository {
  list(): Promise<RoomRecord[]>;
  get(code: string): Promise<RoomRecord | undefined>;
  save(room: RoomRecord): Promise<void>;
  remove(code: string): Promise<void>;
}

export class InMemoryRoomRepository implements RoomRepository {
  private readonly rooms = new Map<string, RoomRecord>();

  async list(): Promise<RoomRecord[]> {
    return [...this.rooms.values()].map((room) => structuredClone(room));
  }

  async get(code: string): Promise<RoomRecord | undefined> {
    const room = this.rooms.get(code.toUpperCase());
    return room ? structuredClone(room) : undefined;
  }

  async save(room: RoomRecord): Promise<void> {
    this.rooms.set(room.code.toUpperCase(), structuredClone(room));
  }

  async remove(code: string): Promise<void> {
    this.rooms.delete(code.toUpperCase());
  }
}
