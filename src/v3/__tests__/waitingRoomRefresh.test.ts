import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import test from 'node:test';
import { io as createClient, type Socket } from 'socket.io-client';
import { Server } from 'socket.io';
import type { JoinRoomAck, V3Command } from '../../../shared/protocol';
import { InMemoryEventStore } from '../../../server/events/store';
import { InMemoryRoomRepository } from '../../../server/rooms/repository';
import { RoomService } from '../../../server/rooms/roomService';
import { bindSocketTransport } from '../../../server/transport/socketTransport';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for state');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test('waiting room summary probes recover member joins and disconnects', async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });

  const httpServer = createHttpServer();
  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
  });
  const rooms = new RoomService(
    new InMemoryRoomRepository(),
    new InMemoryEventStore(),
    { autoDrive: false },
  );
  bindSocketTransport(io, rooms);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  const serverUrl = `http://127.0.0.1:${address.port}`;
  globalThis.localStorage.setItem('wolf-server-url', serverUrl);

  const { setServerUrl } = await import('../../net/socket');
  setServerUrl(serverUrl);
  const { useV3Store } = await import('../../stores/v3Store');
  let guest: Socket | null = null;

  try {
    assert.equal(
      await useV3Store.getState().createRoom(
        'Host',
        'Waiting room refresh',
        false,
      ),
      true,
    );
    const initial = useV3Store.getState();
    assert.equal(initial.room?.members.length, 1);
    assert.ok(initial.session?.credentials.joinToken);

    guest = createClient(serverUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    await new Promise<void>((resolve, reject) => {
      guest?.once('connect', resolve);
      guest?.once('connect_error', reject);
    });
    const command: V3Command & { actorName: string } = {
      meta: {
        commandId: crypto.randomUUID(),
        actorId: 'guest',
        sentAt: Date.now(),
      },
      actorName: 'Guest',
      command: {
        type: 'room.join',
        payload: {
          roomCode: initial.room!.code,
          joinToken: initial.session!.credentials.joinToken!,
        },
      },
    };
    const joined = await new Promise<JoinRoomAck>((resolve) => {
      guest?.emit('v3:command', command, resolve);
    });
    assert.equal(joined.ok, true);

    await useV3Store.getState().refreshRooms();
    assert.equal(useV3Store.getState().room?.members.length, 2);
    assert.equal(
      useV3Store
        .getState()
        .room?.members.find((member) => !member.isHost)
        ?.connected,
      true,
    );

    guest.disconnect();
    await waitFor(async () => {
      const record = await rooms.getRecord(initial.room!.code);
      return (
        record?.members.find((member) => member.id === 'guest')
          ?.connected === false
      );
    });
    await useV3Store.getState().refreshRooms();
    assert.equal(useV3Store.getState().room?.members.length, 2);
    assert.equal(
      useV3Store
        .getState()
        .room?.members.find((member) => !member.isHost)
        ?.connected,
      false,
    );
  } finally {
    guest?.disconnect();
    useV3Store.getState().leaveRoom();
    await rooms.close();
    await new Promise<void>((resolve, reject) => {
      io.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});
