import { createServer, type Server as HttpServer } from 'node:http';
import { writeFile as writeFilePromise } from 'node:fs/promises';
import path from 'node:path';
import { Server as SocketIOServer } from 'socket.io';
import type { AIConfig } from '../../shared/types';
import type { AsyncAtomicFileOperations } from '../filePersistence';
import { FileEventStore } from '../events/fileStore';
import { ensureSecureDirectory } from '../filePersistence';
import { HttpAIProvider } from '../ai/httpProvider';
import type { HttpAIProviderOptions } from '../ai/httpProvider';
import { defaultAITelemetry } from '../ai/aiTelemetry';
import { FileInsightStore } from '../review/insightStore';
import { FileReviewRepository } from '../review/fileReviewRepository';
import { ReviewPipeline } from '../review/reviewPipeline';
import { resolveRuntimeConfig, type RuntimeConfig } from '../runtimeConfig';
import {
  EncryptedFileCredentialStore,
  EndpointPolicy,
  InMemoryCredentialStore,
  isAllowedOrigin,
  isSecureRequest,
  parseRuntimeSecurityConfig,
  SafeHttpClient,
  type RuntimeSecurityConfig,
} from '../security';
import { FileLifecycleOutbox } from '../rooms/lifecycleOutbox';
import { FileRoomRepository } from '../rooms/fileRepository';
import { RoomService } from '../rooms/roomService';
import {
  bindSocketTransport,
  type SocketTransportController,
  type SocketTransportOptions,
} from '../transport/socketTransport';
import {
  createTestControlPort,
  type MutableTestClock,
  type TestControlPort,
} from './testControlPort';

export interface V3ApplicationOptions {
  /** Test composition must opt in explicitly; production never exposes it. */
  enableTestControl?: boolean;
  runtime?: RuntimeConfig;
  security?: RuntimeSecurityConfig;
  socket?: SocketTransportOptions;
  clock?: () => number;
  testClock?: MutableTestClock;
}

export interface V3Application {
  readonly runtime: RuntimeConfig;
  readonly security: RuntimeSecurityConfig;
  readonly httpServer: HttpServer;
  readonly io: SocketIOServer;
  readonly rooms: RoomService;
  readonly transport: SocketTransportController;
  readonly testControl?: TestControlPort;
  start(port?: number, host?: string): Promise<string>;
  close(): Promise<void>;
}

const responseHeaders = (security: RuntimeSecurityConfig): Record<string, string> =>
  security.environment === 'production'
    ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' }
    : {};

/**
 * The only server composition root. Production, QC, integration and E2E
 * callers all construct V3 through this function; test-only controls are an
 * explicit option and are never mounted by the production entrypoint.
 */
export const createV3Application = async (
  options: V3ApplicationOptions = {},
): Promise<V3Application> => {
  const runtime = options.runtime ?? resolveRuntimeConfig();
  const security = options.security ?? parseRuntimeSecurityConfig();
  if (options.enableTestControl && runtime.environment !== 'test') {
    throw new Error('test control is available only in the test composition');
  }
  const defaultTestClock = options.enableTestControl
    ? (() => {
        let current = Date.now();
        return {
          get now() { return current; },
          advance: (milliseconds: number) => { current += milliseconds; return current; },
        } satisfies MutableTestClock;
      })()
    : undefined;
  const testClock = options.testClock ?? defaultTestClock;
  const now = options.clock ?? (testClock ? () => testClock.now : Date.now);
  const testFaults = { provider: false, write: false };
  const persistence = options.enableTestControl
    ? {
        operations: {
          writeFile: async (file: string, value: string, encoding: 'utf8') => {
            if (testFaults.write) throw new Error('TEST_WRITE_FAILURE');
            return writeFilePromise(file, value, encoding);
          },
        } satisfies Partial<AsyncAtomicFileOperations>,
      }
    : {};

  await ensureSecureDirectory(runtime.dataDir);
  await Promise.all([
    ensureSecureDirectory(runtime.secretsDir, { dataRoot: runtime.dataDir }),
    ensureSecureDirectory(runtime.outboxDir, { dataRoot: runtime.dataDir }),
  ]);

  const httpServer = createServer((request, response) => {
    if (security.environment === 'production' && !isSecureRequest(request, security)) {
      response.writeHead(426, { 'content-type': 'application/json', ...responseHeaders(security) });
      response.end(JSON.stringify({ ok: false, code: 'INSECURE_TRANSPORT' }));
      return;
    }
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json', ...responseHeaders(security) });
      response.end(JSON.stringify({ ok: true, service: 'werewolf-v3' }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json', ...responseHeaders(security) });
    response.end(JSON.stringify({ ok: false, code: 'NOT_FOUND' }));
  });
  const io = new SocketIOServer(httpServer, {
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
    ...persistence,
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
            persistence,
          },
        )
      : security.environment === 'production'
        ? (() => { throw new Error('production requires WW_SECRET_KEY'); })()
        : new InMemoryCredentialStore();
  const reviewRepository = new FileReviewRepository(runtime.reviewsFile, { dataRoot: runtime.dataDir, ...persistence });
  const insightStore = new FileInsightStore(runtime.insightsFile, { dataRoot: runtime.dataDir, ...persistence });
  const reviewPipeline = new ReviewPipeline(eventStore, reviewRepository, { insightStore });
  const endpointPolicy = new EndpointPolicy({
    environment: security.environment,
    allowPrivateEndpoints: security.allowPrivateAIEndpoints,
    allowlist: security.aiEndpointAllowlist,
  });
  const safeHttpClient = new SafeHttpClient(endpointPolicy);
  const aiProviderFactory = (config: AIConfig, providerOptions: HttpAIProviderOptions) => {
    const provider = new HttpAIProvider(config, { ...providerOptions, safeHttpClient, telemetry: defaultAITelemetry });
    return {
      mode: provider.mode,
      suggest: async (context: Parameters<typeof provider.suggest>[0]) => {
        if (testFaults.provider) throw new Error('TEST_PROVIDER_FAILURE');
        return provider.suggest(context);
      },
    };
  };
  const lifecycleOutbox = new FileLifecycleOutbox(
    path.join(runtime.outboxDir, 'room-lifecycle.json'),
    {
      environment: runtime.environment,
      deploymentNamespace: runtime.deploymentNamespace,
      dataRoot: runtime.dataDir,
    },
  );
  const rooms = new RoomService(new FileRoomRepository(runtime.roomsFile, {
    environment: runtime.environment,
    deploymentNamespace: runtime.deploymentNamespace,
    dataRoot: runtime.dataDir,
    ...persistence,
  }), eventStore, {
    autoDrive: true,
    environment: runtime.environment,
    deploymentNamespace: runtime.deploymentNamespace,
    waitingRoomTtlMs: runtime.waitingRoomTtlMs,
    endedRoomTtlMs: runtime.endedRoomTtlMs,
    roomSweepIntervalMs: runtime.roomSweepIntervalMs,
    startupGraceMs: runtime.startupGraceMs,
    clock: now,
    session: { now },
    credentialStore,
    lifecycleOutbox,
    credentialNamespace: runtime.deploymentNamespace,
    endpointPolicy,
    aiProviderFactory,
    aiTelemetry: defaultAITelemetry,
    reviewPipeline,
    insightStore,
  });
  await rooms.restore();
  const transport = bindSocketTransport(io, rooms, options.socket);
  const testControl = options.enableTestControl && runtime.environment === 'test'
    ? await createTestControlPort({
        clock: testClock,
        transport,
        rooms,
        token: process.env.WW_TEST_CONTROL_TOKEN,
        onFault: (fault, enabled) => {
          if (fault === 'provider') testFaults.provider = enabled;
          if (fault === 'write') testFaults.write = enabled;
        },
      })
    : undefined;

  let closed = false;
  return {
    runtime,
    security,
    httpServer,
    io,
    rooms,
    transport,
    ...(testControl ? { testControl } : {}),
    start: async (port = Number(process.env.PORT ?? 3001), host = runtime.bindHost) => {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve();
        };
        httpServer.once('error', onError);
        httpServer.listen(port, host, onListening);
      });
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('Could not bind V3 application');
      const scheme = security.environment === 'production' ? 'https' : 'http';
      return `${scheme}://127.0.0.1:${address.port}`;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await testControl?.close();
      await rooms.close();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      if (httpServer.listening) {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    },
  };
};
