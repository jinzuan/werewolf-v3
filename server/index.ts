import { createServer } from 'node:http';
import path from 'node:path';
import { Server } from 'socket.io';
import { FileEventStore } from './events/fileStore';
import { FileRoomRepository } from './rooms/fileRepository';
import { RoomService } from './rooms/roomService';
import { bindSocketTransport } from './transport/socketTransport';
import {
  effectiveRequestProtocol,
  EncryptedFileCredentialStore,
  InMemoryCredentialStore,
  isAllowedOrigin,
  parseRuntimeSecurityConfig,
} from './security';

const security = parseRuntimeSecurityConfig();
const responseHeaders = (): Record<string, string> => security.environment === 'production'
  ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' }
  : {};

const port = Number(process.env.PORT ?? 3001);
const httpServer = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json', ...responseHeaders() });
    response.end(JSON.stringify({ ok: true, service: 'werewolf-v3' }));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json', ...responseHeaders() });
  response.end(JSON.stringify({ ok: false, code: 'NOT_FOUND' }));
});

const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => callback(null, isAllowedOrigin(origin, security)),
    credentials: true,
  },
});
io.use((socket, next) => {
  const origin = socket.handshake.headers.origin;
  if (origin && !isAllowedOrigin(origin, security)) {
    next(new Error('CORS_ORIGIN_NOT_ALLOWED'));
    return;
  }
  const protocol = effectiveRequestProtocol(socket.handshake.headers, security.trustProxy);
  if (security.environment === 'production' && protocol !== 'https') {
    next(new Error('INSECURE_TRANSPORT'));
    return;
  }
  next();
});
const eventStore = new FileEventStore();
const credentialStore = security.secretStore === 'memory'
  ? new InMemoryCredentialStore()
  : security.secretKey
    ? new EncryptedFileCredentialStore(
        process.env.WW_SECRET_FILE ?? path.resolve(process.cwd(), 'server', 'data', 'v3-secrets.json'),
        {
          masterKey: security.secretKey,
          keyId: security.secretKeyId,
          environment: security.environment,
        },
      )
    : security.environment === 'production'
      ? (() => { throw new Error('production requires WW_SECRET_KEY'); })()
      : (() => {
          console.warn('[server:security] memory SecretStore selected; AI credentials expire on restart');
          return new InMemoryCredentialStore();
        })();
const roomService = new RoomService(new FileRoomRepository(), eventStore, {
  // Mixed rooms hand computer turns back to the room service after each
  // human command. Quick computer rooms already opt into this path directly.
  autoDrive: true,
  credentialStore,
  credentialNamespace: process.env.WW_DEPLOYMENT_NAMESPACE ?? security.environment,
});

await roomService.restore();
bindSocketTransport(io, roomService, { security });

httpServer.listen(port, () => {
  const scheme = security.environment === 'production' ? 'https' : 'http';
  console.log(`[server:v3] listening on ${scheme}://127.0.0.1:${port}`);
  if (security.environment !== 'production') {
    console.warn('[server:security] development/test HTTP exception is limited to loopback');
  }
});
