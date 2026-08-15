import { isIP } from 'node:net';

export interface TrustedProxySource {
  address: string;
  family: 4 | 6;
  prefixLength: number;
}

export interface TrustedProxyPolicyConfig {
  enabled: boolean;
  sources: readonly TrustedProxySource[];
  bindHost: string;
}

export interface RequestLike {
  headers?: Pick<Headers, 'get'> | Record<string, string | string[] | undefined>;
  socket?: {
    remoteAddress?: string;
    encrypted?: boolean;
  };
}

export class TrustedProxyPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustedProxyPolicyError';
  }
}

const normalizeAddress = (value: string): string => {
  const trimmed = value.trim().replace(/^\[|\]$/g, '').split('%', 1)[0];
  if (isIP(trimmed) === 0) {
    throw new TrustedProxyPolicyError(`invalid trusted proxy address: ${value}`);
  }
  return trimmed.toLowerCase();
};

const ipv4Bytes = (value: string): number[] => value.split('.').map(Number);

const ipv6Bytes = (value: string): number[] => {
  const normalized = value.toLowerCase().split('%', 1)[0];
  const [leftRaw, rightRaw] = normalized.split('::');
  const parse = (part: string): number[] => part
    .split(':')
    .filter(Boolean)
    .flatMap((chunk) => {
      if (!chunk.includes('.')) return [Number.parseInt(chunk, 16) >> 8, Number.parseInt(chunk, 16) & 0xff];
      const octets = ipv4Bytes(chunk);
      return octets.length === 4 ? octets : [];
    });
  const left = parse(leftRaw ?? '');
  const right = parse(rightRaw ?? '');
  if (!normalized.includes('::')) return [...left, ...right];
  return [...left, ...Array.from({ length: 16 - left.length - right.length }, () => 0), ...right];
};

const canonicalAddress = (value: string): string => {
  const normalized = normalizeAddress(value);
  if (isIP(normalized) !== 6) return normalized;
  const bytes = ipv6Bytes(normalized);
  const mapped = bytes.length === 16 &&
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff && bytes[11] === 0xff;
  return mapped
    ? bytes.slice(12).join('.')
    : normalized;
};

const bytesFor = (value: string): number[] => {
  const normalized = canonicalAddress(value);
  return isIP(normalized) === 4 ? ipv4Bytes(normalized) : ipv6Bytes(normalized);
};

const maskMatches = (
  address: readonly number[],
  network: readonly number[],
  prefixLength: number,
): boolean => {
  const wholeBytes = Math.floor(prefixLength / 8);
  const remainingBits = prefixLength % 8;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (address[index] !== network[index]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = 0xff << (8 - remainingBits) & 0xff;
  return (address[wholeBytes] & mask) === (network[wholeBytes] & mask);
};

export const parseTrustedProxySource = (value: string): TrustedProxySource => {
  const [rawAddress, rawPrefix, ...extra] = value.trim().split('/');
  if (!rawAddress || extra.length > 0) {
    throw new TrustedProxyPolicyError(`invalid trusted proxy CIDR: ${value}`);
  }
  const address = canonicalAddress(rawAddress);
  const family = isIP(address) as 4 | 6;
  const prefixLength = rawPrefix === undefined
    ? family === 4 ? 32 : 128
    : Number(rawPrefix);
  const max = family === 4 ? 32 : 128;
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > max) {
    throw new TrustedProxyPolicyError(`invalid trusted proxy prefix: ${value}`);
  }
  return { address, family, prefixLength };
};

export const parseTrustedProxySources = (
  value: string | readonly string[] | undefined,
): TrustedProxySource[] => {
  const values: readonly string[] = value === undefined
    ? []
    : typeof value === 'string'
      ? value.split(',')
      : value;
  return values
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseTrustedProxySource);
};

export class TrustedProxyPolicy {
  readonly config: TrustedProxyPolicyConfig;

  constructor(config: TrustedProxyPolicyConfig) {
    this.config = Object.freeze({
      enabled: config.enabled,
      sources: Object.freeze(config.sources.map((source) => Object.freeze({ ...source }))),
      bindHost: config.bindHost,
    });
  }

  isTrusted(remoteAddress: string | undefined): boolean {
    if (!this.config.enabled || !remoteAddress) return false;
    let address: string;
    try {
      address = canonicalAddress(remoteAddress);
    } catch {
      return false;
    }
    const family = isIP(address) as 4 | 6;
    const addressBytes = bytesFor(address);
    return this.config.sources.some((source) =>
      source.family === family &&
      maskMatches(addressBytes, bytesFor(source.address), source.prefixLength));
  }

  isSecureRequest(request: RequestLike): boolean {
    return effectiveRequestProtocol(request, this) === 'https';
  }
}

const headerValue = (
  headers: RequestLike['headers'],
  name: string,
): string | string[] | undefined => {
  if (!headers) return undefined;
  if (typeof (headers as Pick<Headers, 'get'>).get === 'function') {
    return (headers as Pick<Headers, 'get'>).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  return record[name] ?? record[name.toLowerCase()];
};

const directProtocolOf = (request: RequestLike): 'http' | 'https' =>
  request.socket?.encrypted === true ? 'https' : 'http';

/**
 * Resolve transport security from the peer socket first. Forwarded headers
 * are meaningful only after the peer has been matched against the configured
 * proxy networks, and a multi-value/unknown value is deliberately plaintext.
 */
export const effectiveRequestProtocol = (
  request: RequestLike,
  policy: TrustedProxyPolicy,
): 'http' | 'https' => {
  const direct = directProtocolOf(request);
  if (!policy.isTrusted(request.socket?.remoteAddress)) return direct;
  const forwarded = headerValue(request.headers, 'x-forwarded-proto');
  if (Array.isArray(forwarded)) return 'http';
  if (forwarded === undefined) return direct;
  const value = forwarded.trim().toLowerCase();
  if (value === 'https') return 'https';
  if (value === 'http') return 'http';
  return 'http';
};
