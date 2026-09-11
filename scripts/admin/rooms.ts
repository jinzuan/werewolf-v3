import path from 'node:path';
import { FileEventStore } from '../../server/events/fileStore';
import { FileRoomRepository } from '../../server/rooms/fileRepository';
import { RoomService } from '../../server/rooms/roomService';
import type { RuntimeEnvironment } from '../../server/runtimeConfig';
import { FileLifecycleOutbox } from '../../server/rooms/lifecycleOutbox';
import {
  EncryptedFileCredentialStore,
  InMemoryCredentialStore,
} from '../../server/security';

type Command = 'list-expired' | 'sweep' | 'remove';

const args = process.argv.slice(2);
const command = args[0] as Command | undefined;

const valueFor = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const fail = (message: string): never => {
  throw new Error(`[rooms-admin] ${message}`);
};

if (!command || !['list-expired', 'sweep', 'remove'].includes(command)) {
  fail('usage: list-expired|sweep|remove --data-dir ABSOLUTE --namespace NAME [--room-code CODE]');
}
const dataDir = valueFor('--data-dir');
const namespace = valueFor('--namespace');
if (!dataDir || !path.isAbsolute(dataDir) || path.parse(dataDir)!.root === dataDir) {
  fail('--data-dir must be an explicit absolute, non-root directory.');
}
if (!namespace || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(namespace)) {
  fail('--namespace is required and must be a safe deployment namespace.');
}

const environment = (valueFor('--environment') ?? process.env.WW_ENV ?? 'development') as RuntimeEnvironment;
if (!['production', 'development', 'test'].includes(environment)) {
  fail('--environment must be production, development, or test.');
}

const repository = new FileRoomRepository(path.join(dataDir, 'rooms.json'), {
  environment,
  deploymentNamespace: namespace,
});
const secretKey = process.env.WW_SECRET_KEY;
if (environment === 'production' && !secretKey) {
  fail('production room cleanup requires WW_SECRET_KEY.');
}
const credentialStore = secretKey
  ? new EncryptedFileCredentialStore(
      process.env.WW_SECRET_FILE ?? path.join(dataDir, 'secrets', 'credentials.json'),
      {
        masterKey: secretKey,
        keyId: process.env.WW_SECRET_KEY_ID,
        environment,
        dataRoot: dataDir,
      },
    )
  : new InMemoryCredentialStore();
const lifecycleOutbox = new FileLifecycleOutbox(path.join(dataDir, 'outbox', 'room-lifecycle.json'), {
  environment,
  deploymentNamespace: namespace,
  dataRoot: dataDir,
});
const service = new RoomService(
  repository,
  new FileEventStore(path.join(dataDir, 'events.json'), {
    environment,
    deploymentNamespace: namespace,
  }),
  {
    environment,
    deploymentNamespace: namespace,
    waitingRoomTtlMs: Number(process.env.WW_WAITING_ROOM_TTL_MS ?? 30 * 60 * 1000),
    endedRoomTtlMs: Number(process.env.WW_ENDED_ROOM_TTL_MS ?? 24 * 60 * 60 * 1000),
    roomSweepIntervalMs: 0,
    lifecycleOutbox,
    credentialStore,
    credentialNamespace: namespace,
  },
);

try {
  if (command === 'list-expired') {
    const rooms = await service.listExpiredRooms();
    console.log(JSON.stringify(rooms.map((room) => ({
      roomCode: room.code,
      status: room.status,
      reason: room.status === 'ended' ? 'ended_room_ttl' : 'offline_waiting_room_ttl',
      lastActivityAt: room.lastActivityAt,
    }))));
  } else if (command === 'sweep') {
    console.log(JSON.stringify(await service.sweepExpiredRooms()));
  } else {
    const roomCode = valueFor('--room-code');
    if (!roomCode || !/^[A-Za-z0-9]{3,32}$/.test(roomCode)) {
      fail('remove requires a valid --room-code.');
    }
    const room = await repository.get(roomCode);
    if (!room) fail(`room ${roomCode} was not found.`);
    console.log(JSON.stringify({ roomCode: room.code, removed: await service.adminRemove(roomCode) }));
  }
} finally {
  await service.close();
}
