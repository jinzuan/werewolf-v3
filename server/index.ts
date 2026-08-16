import { createServer } from 'node:http';
import path from 'node:path';
import { Server } from 'socket.io';
import { FileEventStore } from './events/fileStore';
import { FileRoomRepository } from './rooms/fileRepository';
import { RoomService } from './rooms/roomService';
import { HttpAIProvider } from './ai/httpProvider';
import type { HttpAIProviderOptions } from './ai/httpProvider';
import { defaultAITelemetry } from './ai/aiTelemetry';
import type { AIConfig } from '../shared/types';
import { FileInsightStore } from './review/insightStore';
import { FileReviewRepository } from './review/fileReviewRepository';
import { ReviewPipeline } from './review/reviewPipeline';
import { bindSocketTransport } from './transport/socketTransport';
import { ensureSecureDirectory } from './filePersistence';
import { resolveRuntimeConfig } from './runtimeConfig';
import {
  EncryptedFileCredentialStore,
  EndpointPolicy,
  InMemoryCredentialStore,
  isSecureRequest,
  isAllowedOrigin,
  parseRuntimeSecurityConfig,
  SafeHttpClient,
  InMemoryRateLimitStore,
  JoinRateLimiter,
} from './security';
import { FileLifecycleOutbox } from './rooms/lifecycleOutbox';
import { scanLegacySecretBackups } from './security/secretMigration';

const security = parseRuntimeSecurityConfig();
const responseHeaders = (): Record<string, string> => security.environment === 'production'
  ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' }
  : {};

const port = Number(process.env.PORT ?? 3001);
const runtime = resolveRuntimeConfig();
await ensureSecureDirectory(runtime.dataDir);
await Promise.all([
  ensureSecureDirectory(runtime.secretsDir, { dataRoot: runtime.dataDir }),
  ensureSecureDirectory(runtime.outboxDir, { dataRoot: runtime.dataDir }),
]);
const httpServer = createServer((request, response) => {
  if (security.environment === 'production' && !isSecureRequest(request, security)) {
    response.writeHead(426, { 'content-type': 'application/json', ...responseHeaders() });
    response.end(JSON.stringify({ ok: false, code: 'INSECURE_TRANSPORT' }));
    return;
  }
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
  if (security.environment === 'production' && !isSecureRequest(socket.request, security)) {
    next(new Error('INSECURE_TRANSPORT'));
    return;
  }
  next();
});
const eventStore = new FileEventStore(runtime.eventsFile, {
  environment: runtime.environment,
  deploymentNamespace: runtime.deploymentNamespace,
  dataRoot: runtime.dataDir,
});
const credentialStore = security.secretStore === 'memory'
  ? new InMemoryCredentialStore()
  : security.secretKey
    ? new EncryptedFileCredentialStore(
        process.env.WW_SECRET_FILE ?? runtime.credentialsFile,
        {
          masterKey: security.secretKey,
          keyId: security.secretKeyId,
          environment: security.environment,
          dataRoot: runtime.dataDir,
        },
      )
    : security.environment === 'production'
      ? (() => { throw new Error('production requires WW_SECRET_KEY'); })()
      : (() => {
          console.warn('[server:security] memory SecretStore selected; AI credentials expire on restart');
          return new InMemoryCredentialStore();
        })();
const reviewRepository = new FileReviewRepository(runtime.reviewsFile, {
  dataRoot: runtime.dataDir,
});
const insightStore = new FileInsightStore(runtime.insightsFile, {
  dataRoot: runtime.dataDir,
});
const reviewPipeline = new ReviewPipeline(eventStore, reviewRepository, { insightStore });
const endpointPolicy = new EndpointPolicy({
  environment: security.environment,
  allowPrivateEndpoints: security.allowPrivateAIEndpoints,
  allowlist: security.aiEndpointAllowlist,
});
await scanLegacySecretBackups({
  dataRoot: runtime.dataDir,
  secretRoot: runtime.secretsDir,
  namespace: runtime.deploymentNamespace,
  store: credentialStore,
  endpointPolicy,
  auditPath: path.join(runtime.secretsDir, 'legacy-secret-migration-audit.json'),
});
if (runtime.rateLimitStore !== 'memory') {
  throw new Error('shared RateLimitStore must be injected by the deployment composition root');
}
const joinRateLimiter = new JoinRateLimiter({
  store: new InMemoryRateLimitStore(),
  capacity: runtime.joinRateLimitCapacity,
  refillPerSecond: runtime.joinRateLimitRefillPerSecond,
});
const safeHttpClient = new SafeHttpClient(endpointPolicy);
const aiProviderFactory = (config: AIConfig, options: HttpAIProviderOptions) =>
  new HttpAIProvider(config, { ...options, safeHttpClient, telemetry: defaultAITelemetry });
const lifecycleOutbox = new FileLifecycleOutbox(
  path.join(runtime.outboxDir, 'room-lifecycle.json'),
  {
    environment: runtime.environment,
    deploymentNamespace: runtime.deploymentNamespace,
    dataRoot: runtime.dataDir,
  },
);
const roomService = new RoomService(new FileRoomRepository(runtime.roomsFile, {
  environment: runtime.environment,
  deploymentNamespace: runtime.deploymentNamespace,
  dataRoot: runtime.dataDir,
}), eventStore, {
  // Mixed rooms hand computer turns back to the room service after each
  // human command. Quick computer rooms already opt into this path directly.
  autoDrive: true,
  environment: runtime.environment,
  deploymentNamespace: runtime.deploymentNamespace,
  waitingRoomTtlMs: runtime.waitingRoomTtlMs,
  endedRoomTtlMs: runtime.endedRoomTtlMs,
  roomSweepIntervalMs: runtime.roomSweepIntervalMs,
  startupGraceMs: runtime.startupGraceMs,
  credentialStore,
  lifecycleOutbox,
  credentialNamespace: runtime.deploymentNamespace,
  endpointPolicy,
  aiProviderFactory,
  aiTelemetry: defaultAITelemetry,
  reviewPipeline,
  insightStore,
});

await roomService.restore();
bindSocketTransport(io, roomService, { security, joinRateLimiter });

httpServer.listen(port, runtime.bindHost, () => {
  const scheme = security.environment === 'production' ? 'https' : 'http';
  console.log(
    `[server:v3] listening on ${scheme}://${runtime.bindHost}:${port} ` +
      `env=${runtime.environment} namespace=${runtime.deploymentNamespace}`,
  );
  if (security.environment !== 'production') {
    console.warn('[server:security] development/test HTTP exception is limited to loopback');
  }
});
