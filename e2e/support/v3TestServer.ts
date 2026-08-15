import { createServer as createHttpServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Server } from 'socket.io';
import { FileEventStore } from '../../server/events/fileStore';
import { FileRoomRepository } from '../../server/rooms/fileRepository';
import { RoomService } from '../../server/rooms/roomService';
import { bindSocketTransport } from '../../server/transport/socketTransport';

if (!process.env.WW_E2E_DATA_DIR || !path.isAbsolute(process.env.WW_E2E_DATA_DIR)) {
  throw new Error('WW_E2E_DATA_DIR must point at an explicit temporary directory.');
}
const dataDir = process.env.WW_E2E_DATA_DIR;
await mkdir(dataDir, { recursive: true });

const httpServer = createHttpServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(404);
  response.end();
});
const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
const rooms = new RoomService(
  new FileRoomRepository(path.join(dataDir, 'rooms.json'), {
    environment: 'test',
    deploymentNamespace: process.env.WW_DEPLOYMENT_NAMESPACE ?? 'e2e',
  }),
  new FileEventStore(path.join(dataDir, 'events.json'), {
    environment: 'test',
    deploymentNamespace: process.env.WW_DEPLOYMENT_NAMESPACE ?? 'e2e',
  }),
  {
    autoDrive: false,
    environment: 'test',
    deploymentNamespace: process.env.WW_DEPLOYMENT_NAMESPACE ?? 'e2e',
  },
);
await rooms.restore();
bindSocketTransport(io, rooms, { dropCreateAckOnce: process.env.WW_TEST_DROP_CREATE_ACK_ONCE === '1' });

const port = Number(process.env.WW_E2E_PORT ?? 0);
await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));
const address = httpServer.address();
if (!address || typeof address === 'string') throw new Error('Could not bind E2E server');
console.log(`[e2e:v3] listening http://127.0.0.1:${address.port}`);

const shutdown = async () => {
  await rooms.close();
  await new Promise<void>((resolve) => io.close(() => resolve()));
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
};
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
