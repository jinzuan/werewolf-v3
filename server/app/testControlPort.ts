import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { RoomService } from '../rooms/roomService';
import type { SocketTransportController, TestFault } from '../transport/socketTransport';

export interface MutableTestClock {
  now: number;
  advance(milliseconds: number): number;
}

export interface TestControlPort {
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}

export interface TestControlPortOptions {
  clock?: MutableTestClock;
  transport: SocketTransportController;
  rooms: RoomService;
  token?: string;
  onFault?: (fault: TestFault, enabled: boolean) => void;
}

const json = (response: import('node:http').ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
};

const readBody = async (request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 16_384) throw new Error('test-control body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('test-control body must be an object');
  return parsed as Record<string, unknown>;
};

const validFaults = new Set<TestFault>([
  'create_ack',
  'mutation_ack',
  'mutation_push',
  'provider',
  'write',
]);

/**
 * A loopback-only, token-protected control plane used only by E2E
 * composition. It is a separate listener so production HTTP never gains a
 * test backdoor or a hidden route.
 */
export const createTestControlPort = async (
  options: TestControlPortOptions,
): Promise<TestControlPort> => {
  const token = options.token ?? randomBytes(24).toString('base64url');
  const faults = new Set<TestFault>();
  const server = createServer(async (request, response) => {
    const supplied = request.headers['x-test-control-token'] ??
      (request.headers.authorization?.startsWith('Bearer ')
        ? request.headers.authorization.slice('Bearer '.length)
        : undefined);
    if (supplied !== token) {
      json(response, 401, { ok: false, code: 'CONTROL_UNAUTHORIZED' });
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      json(response, 200, { ok: true, service: 'v3-test-control' });
      return;
    }
    try {
      if (request.method === 'GET' && request.url === '/status') {
        json(response, 200, {
          ok: true,
          clock: options.clock?.now ?? null,
          faults: [...faults].sort(),
        });
        return;
      }
      if (request.method !== 'POST') {
        json(response, 404, { ok: false, code: 'NOT_FOUND' });
        return;
      }
      const body = await readBody(request);
      if (request.url === '/clock/advance') {
        const milliseconds = body.ms;
        if (!options.clock || !Number.isSafeInteger(milliseconds) || (milliseconds as number) < 0) {
          json(response, 400, { ok: false, code: 'INVALID_CLOCK_ADVANCE' });
          return;
        }
        const now = options.clock.advance(milliseconds as number);
        await options.rooms.sweepExpiredRooms();
        json(response, 200, { ok: true, now });
        return;
      }
      if (request.url === '/fault') {
        const fault = body.fault;
        const enabled = body.enabled !== false;
        if (typeof fault !== 'string' || !validFaults.has(fault as TestFault)) {
          json(response, 400, { ok: false, code: 'INVALID_FAULT' });
          return;
        }
        const typedFault = fault as TestFault;
        if (enabled) faults.add(typedFault);
        else faults.delete(typedFault);
        options.transport.setFault(typedFault, enabled);
        options.onFault?.(typedFault, enabled);
        json(response, 200, { ok: true, fault: typedFault, enabled });
        return;
      }
      if (request.url === '/faults/clear') {
        faults.clear();
        options.transport.clearFaults();
        for (const fault of validFaults) options.onFault?.(fault, false);
        json(response, 200, { ok: true });
        return;
      }
      json(response, 404, { ok: false, code: 'NOT_FOUND' });
    } catch {
      json(response, 400, { ok: false, code: 'INVALID_CONTROL_REQUEST' });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind test control port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
