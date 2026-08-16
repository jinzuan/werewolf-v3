import { request as httpRequest } from 'node:http';
import { connect as tcpConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { URL } from 'node:url';
import {
  EndpointPolicy,
  EndpointPolicyError,
  type EndpointValidationContext,
  type ValidatedEndpoint,
} from './endpointPolicy';

export interface SafeHttpRequestOptions extends RequestInit {
  /** Provider context is checked by the same EndpointPolicy instance. */
  endpointContext?: EndpointValidationContext;
}

export interface SafeHttpTransportRequest {
  url: string;
  options: RequestInit;
  endpoint: ValidatedEndpoint;
}

export type SafeHttpTransport =
  (request: SafeHttpTransportRequest) => Promise<Response>;

export interface SafeHttpClientOptions {
  /** Test-only transport. It must consume endpoint.addresses as its pin. */
  transport?: SafeHttpTransport;
  maxResponseBytes?: number;
}

export type SafeHttpClientCode =
  | 'ENDPOINT_POLICY'
  | 'DNS_REBINDING'
  | 'CONNECTION_FAILED'
  | 'RESPONSE_TOO_LARGE';

export class SafeHttpClientError extends Error {
  constructor(public readonly code: SafeHttpClientCode, message = code) {
    super(message);
    this.name = 'SafeHttpClientError';
  }
}

const headerRecord = (headers: HeadersInit | undefined): Record<string, string> => {
  const result: Record<string, string> = {};
  if (!headers) return result;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { result[key] = value; });
    return result;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) result[key] = value;
    return result;
  }
  for (const [key, value] of Object.entries(headers)) {
    result[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
};

const normalizedAddress = (address: string): string =>
  address.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%[^:]+$/, '');

const addressMatches = (remote: string | undefined, expected: readonly string[]): boolean => {
  if (!remote) return false;
  const normalized = normalizedAddress(remote);
  return expected.some((entry) => normalizedAddress(entry) === normalized);
};

const abortError = (): Error => Object.assign(new Error('request aborted'), { name: 'AbortError' });

const connectSocket = (
  address: string,
  port: number,
  signal: AbortSignal | undefined,
): Promise<Socket> => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(abortError());
    return;
  }
  const socket = tcpConnect({ host: address, port });
  const onAbort = () => {
    socket.destroy();
    reject(abortError());
  };
  const cleanup = () => signal?.removeEventListener('abort', onAbort);
  socket.once('connect', () => { cleanup(); resolve(socket); });
  socket.once('error', (error) => { cleanup(); reject(error); });
  signal?.addEventListener('abort', onAbort, { once: true });
});

const secureSocket = (
  socket: Socket,
  hostname: string,
  signal: AbortSignal | undefined,
): Promise<TLSSocket> => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    socket.destroy();
    reject(abortError());
    return;
  }
  const tlsSocket = tlsConnect({
    socket,
    servername: hostname,
    rejectUnauthorized: true,
  });
  const onAbort = () => {
    tlsSocket.destroy();
    reject(abortError());
  };
  const cleanup = () => signal?.removeEventListener('abort', onAbort);
  tlsSocket.once('secureConnect', () => { cleanup(); resolve(tlsSocket); });
  tlsSocket.once('error', (error) => { cleanup(); reject(error); });
  signal?.addEventListener('abort', onAbort, { once: true });
});

const bodyBytes = (body: BodyInit | null | undefined): Buffer | undefined => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return Buffer.from(String(body));
};

/**
 * A fetch-shaped client whose real transport opens a socket to the validated
 * address set. The original hostname remains the HTTP Host/SNI name.
 */
export class SafeHttpClient {
  private readonly maxResponseBytes: number;

  constructor(
    private readonly endpointPolicy: EndpointPolicy,
    private readonly options: SafeHttpClientOptions = {},
  ) {
    this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
  }

  async request(url: string, options: SafeHttpRequestOptions = {}): Promise<Response> {
    let endpoint: ValidatedEndpoint;
    try {
      endpoint = await this.endpointPolicy.validate(url, options.endpointContext);
    } catch (error) {
      if (error instanceof EndpointPolicyError) {
        throw new SafeHttpClientError('ENDPOINT_POLICY');
      }
      throw error;
    }
    const { endpointContext: _context, ...requestOptions } = options;
    if (this.options.transport) {
      // A fake transport is given the complete validated pin. This keeps
      // tests honest: a fake cannot accidentally turn back into bare fetch.
      return this.options.transport({ url: endpoint.url, options: requestOptions, endpoint });
    }
    if (!endpoint.addresses.length) throw new SafeHttpClientError('CONNECTION_FAILED');
    return this.requestPinned(endpoint, requestOptions);
  }

  fetch(url: string, options: SafeHttpRequestOptions = {}): Promise<Response> {
    return this.request(url, options);
  }

  private async requestPinned(endpoint: ValidatedEndpoint, options: RequestInit): Promise<Response> {
    const parsed = new URL(endpoint.url);
    const errors: unknown[] = [];
    for (const address of endpoint.addresses) {
      let socket: Socket | TLSSocket | undefined;
      try {
        socket = await connectSocket(address.address, endpoint.port, options.signal ?? undefined);
        if (!addressMatches(socket.remoteAddress, endpoint.addresses.map((item) => item.address))) {
          socket.destroy();
          throw new SafeHttpClientError('DNS_REBINDING');
        }
        if (parsed.protocol === 'https:') {
          socket = await secureSocket(socket, endpoint.hostname, options.signal ?? undefined);
          if (!addressMatches(socket.remoteAddress, endpoint.addresses.map((item) => item.address))) {
            socket.destroy();
            throw new SafeHttpClientError('DNS_REBINDING');
          }
        }
        return await this.requestOverSocket(parsed, endpoint, options, socket);
      } catch (error) {
        socket?.destroy();
        errors.push(error);
        if (error instanceof SafeHttpClientError && error.code === 'DNS_REBINDING') throw error;
        if ((options.signal as AbortSignal | undefined)?.aborted) throw abortError();
      }
    }
    throw new SafeHttpClientError('CONNECTION_FAILED');
  }

  private requestOverSocket(
    parsed: URL,
    endpoint: ValidatedEndpoint,
    options: RequestInit,
    socket: Socket | TLSSocket,
  ): Promise<Response> {
    const headers = headerRecord(options.headers);
    const requestBody = bodyBytes(options.body);
    const requestHeaders = { ...headers };
    if (requestBody && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-length')) {
      requestHeaders['content-length'] = String(requestBody.byteLength);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        request.destroy();
        reject(error);
      };
      const signal = options.signal;
      const onAbort = () => fail(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      const request = httpRequest({
        hostname: endpoint.hostname,
        port: endpoint.port,
        method: options.method ?? 'GET',
        path: `${parsed.pathname}${parsed.search}`,
        headers: requestHeaders,
        agent: false,
        // The socket was connected and checked before Authorization/body are
        // made available to ClientRequest. No hostname lookup can occur here.
        createConnection: () => socket,
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.byteLength;
          if (size > this.maxResponseBytes) {
            response.destroy(new SafeHttpClientError('RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(buffer);
        });
        response.once('error', fail);
        response.once('end', () => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) responseHeaders.set(key, value.join(', '));
            else if (value !== undefined) responseHeaders.set(key, value);
          }
          resolve(new Response(Buffer.concat(chunks), {
            status: response.statusCode ?? 0,
            headers: responseHeaders,
          }));
        });
      });
      request.once('error', fail);
      request.once('close', () => signal?.removeEventListener('abort', onAbort));
      if (requestBody) request.write(requestBody);
      request.end();
    });
  }
}
