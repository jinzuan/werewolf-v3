import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type SecurityEnvironment = 'production' | 'development' | 'test';
export type AIEndpointProvider = 'siliconflow' | 'deepseek' | 'local' | 'custom';

export type EndpointPolicyCode =
  | 'INVALID_ENDPOINT'
  | 'ENDPOINT_SCHEME_NOT_ALLOWED'
  | 'ENDPOINT_HOST_NOT_ALLOWED'
  | 'ENDPOINT_PORT_NOT_ALLOWED'
  | 'ENDPOINT_DNS_FAILED'
  | 'ENDPOINT_PRIVATE_ADDRESS'
  | 'ENDPOINT_REDIRECT_BLOCKED'
  | 'CUSTOM_ENDPOINT_DISABLED';

export class EndpointPolicyError extends Error {
  constructor(
    public readonly code: EndpointPolicyCode,
    message = code,
    public readonly fieldPath = 'endpoint',
  ) {
    super(message);
    this.name = 'EndpointPolicyError';
  }
}

export interface EndpointAddress {
  address: string;
  family: 4 | 6;
}

export interface ValidatedEndpoint {
  url: string;
  origin: string;
  hostname: string;
  port: number;
  addresses: EndpointAddress[];
}

export interface EndpointPolicyOptions {
  environment?: SecurityEnvironment;
  allowPrivateEndpoints?: boolean;
  allowlist?: string | readonly string[];
  officialHosts?: Partial<Record<'siliconflow' | 'deepseek', readonly string[]>>;
  lookup?: (hostname: string) => Promise<EndpointAddress[]>;
  /** Useful for deterministic unit tests with a mocked fetch implementation. */
  resolveDns?: boolean;
}

export interface EndpointValidationContext {
  provider?: AIEndpointProvider;
  /** A test-only transport may use a reserved .test host without DNS. */
  allowReservedTestHost?: boolean;
}

const DEFAULT_OFFICIAL_HOSTS = {
  siliconflow: ['api.siliconflow.cn'],
  deepseek: ['api.deepseek.com'],
} as const;

const normalizeHost = (host: string): string =>
  host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

const normalizeAllowlist = (value: string | readonly string[] | undefined): Set<string> => {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const normalized = new Set<string>();
  for (const raw of values.map((entry) => entry.trim().toLowerCase()).filter(Boolean)) {
    try {
      const parsed = new URL(raw);
      if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) continue;
      const port = parsed.port || (parsed.protocol === 'http:' ? '80' : '443');
      normalized.add(`${normalizeHost(parsed.hostname)}:${port}`);
      normalized.add(normalizeHost(parsed.hostname));
    } catch {
      normalized.add(raw.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
    }
  }
  return normalized;
};

const isIPv4 = (value: string): boolean => isIP(value) === 4;
const isIPv6 = (value: string): boolean => isIP(value) === 6;
const isLoopbackAddress = (value: string): boolean => {
  const v4 = ipv4Parts(value);
  if (v4) return v4[0] === 127;
  const v6 = ipv6Hextets(value);
  return Boolean(v6 && v6.slice(0, 7).every((part) => part === 0) && v6[7] === 1);
};

const ipv4Parts = (value: string): number[] | undefined => {
  if (!isIPv4(value)) return undefined;
  const parts = value.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : undefined;
};

const inIPv4Range = (parts: number[], first: number, second: number, third?: number): boolean => {
  if (parts[0] !== first || parts[1] !== second) return false;
  return third === undefined || parts[2] === third;
};

const ipv6Hextets = (value: string): number[] | undefined => {
  if (!isIPv6(value)) return undefined;
  const normalized = value.toLowerCase().split('%')[0];
  const [leftRaw, rightRaw] = normalized.split('::');
  const parse = (part: string): number[] => part
    .split(':')
    .filter(Boolean)
    .flatMap((item) => {
      if (item.includes('.')) {
        const parts = ipv4Parts(item);
        return parts ? [(parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]] : [];
      }
      const parsed = Number.parseInt(item, 16);
      return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffff ? [parsed] : [];
    });
  const left = parse(leftRaw ?? '');
  const right = parse(rightRaw ?? '');
  if (!normalized.includes('::')) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  return missing >= 1 ? [...left, ...Array.from({ length: missing }, () => 0), ...right] : undefined;
};

const isIPv4Mapped = (parts: number[]): boolean =>
  parts.length === 8 && parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;

/**
 * This is intentionally stricter than an RFC1918-only check.  A public DNS
 * name is rejected if any answer is local, link-local, multicast, reserved,
 * or otherwise not a routable unicast address.  That makes DNS rebinding
 * fail closed when the resolver returns a mixed answer set.
 */
export const isForbiddenAddress = (address: string): boolean => {
  const v4 = ipv4Parts(address);
  if (v4) {
    return (
      v4[0] === 0 ||
      v4[0] === 10 ||
      inIPv4Range(v4, 100, 64) ||
      inIPv4Range(v4, 127, 0) ||
      inIPv4Range(v4, 169, 254) ||
      inIPv4Range(v4, 172, 16) ||
      inIPv4Range(v4, 172, 17) ||
      inIPv4Range(v4, 172, 18) ||
      inIPv4Range(v4, 172, 19) ||
      inIPv4Range(v4, 172, 20) ||
      inIPv4Range(v4, 172, 21) ||
      inIPv4Range(v4, 172, 22) ||
      inIPv4Range(v4, 172, 23) ||
      inIPv4Range(v4, 172, 24) ||
      inIPv4Range(v4, 172, 25) ||
      inIPv4Range(v4, 172, 26) ||
      inIPv4Range(v4, 172, 27) ||
      inIPv4Range(v4, 172, 28) ||
      inIPv4Range(v4, 172, 29) ||
      inIPv4Range(v4, 172, 30) ||
      inIPv4Range(v4, 172, 31) ||
      inIPv4Range(v4, 192, 0) ||
      inIPv4Range(v4, 192, 168) ||
      inIPv4Range(v4, 198, 18) ||
      inIPv4Range(v4, 198, 19) ||
      v4[0] >= 224
    );
  }
  const v6 = ipv6Hextets(address);
  if (!v6) return true;
  if (isIPv4Mapped(v6)) {
    const mapped = `${v6[6] >> 8}.${v6[6] & 0xff}.${v6[7] >> 8}.${v6[7] & 0xff}`;
    return isForbiddenAddress(mapped);
  }
  return (
    v6.every((part) => part === 0) ||
    (v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0 && v6[6] === 0 && v6[7] === 1) ||
    (v6[0] & 0xfe00) === 0xfc00 ||
    (v6[0] & 0xffc0) === 0xfe80 ||
    (v6[0] & 0xff00) === 0xff00 ||
    (v6[0] === 0x2001 && v6[1] === 0x0db8)
  );
};

const defaultLookup = async (hostname: string): Promise<EndpointAddress[]> => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => ({
    address: result.address,
    family: result.family as 4 | 6,
  }));
};

const isReservedTestHost = (hostname: string): boolean => hostname === 'provider.test';

const endpointAllowlistEntry = (hostname: string, port: number): string[] => [
  hostname,
  `${hostname}:${port}`,
];

export class EndpointPolicy {
  private readonly environment: SecurityEnvironment;
  private readonly allowPrivateEndpoints: boolean;
  private readonly allowlist: Set<string>;
  private readonly officialHosts: Record<'siliconflow' | 'deepseek', readonly string[]>;
  private readonly lookup: (hostname: string) => Promise<EndpointAddress[]>;
  private readonly resolveDns: boolean;

  constructor(options: EndpointPolicyOptions = {}) {
    this.environment = options.environment ?? (
      'development'
    );
    this.allowPrivateEndpoints = options.allowPrivateEndpoints === true;
    // Runtime security is resolved by the composition root. This policy is
    // intentionally blind to process.env so a room cannot observe a second
    // security configuration after construction.
    this.allowlist = normalizeAllowlist(options.allowlist);
    this.officialHosts = {
      siliconflow: options.officialHosts?.siliconflow ?? DEFAULT_OFFICIAL_HOSTS.siliconflow,
      deepseek: options.officialHosts?.deepseek ?? DEFAULT_OFFICIAL_HOSTS.deepseek,
    };
    this.lookup = options.lookup ?? defaultLookup;
    this.resolveDns = options.resolveDns ?? true;
  }

  async validate(endpoint: string, context: EndpointValidationContext = {}): Promise<ValidatedEndpoint> {
    if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2_048) {
      throw new EndpointPolicyError('INVALID_ENDPOINT');
    }

    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new EndpointPolicyError('INVALID_ENDPOINT');
    }
    const hostname = normalizeHost(parsed.hostname);
    if (!hostname || parsed.username || parsed.password || parsed.hash || parsed.search) {
      throw new EndpointPolicyError('INVALID_ENDPOINT');
    }
    if (parsed.protocol !== 'https:') {
      const localDevelopmentHttp =
        this.environment !== 'production' && parsed.protocol === 'http:' &&
        (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ||
          (isIP(hostname) !== 0 && isLoopbackAddress(hostname)));
      if (!localDevelopmentHttp) throw new EndpointPolicyError('ENDPOINT_SCHEME_NOT_ALLOWED');
    }

    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new EndpointPolicyError('ENDPOINT_PORT_NOT_ALLOWED');
    }
    const official = context.provider === 'siliconflow' || context.provider === 'deepseek';
    const officialHosts = official ? this.officialHosts[context.provider!] : [];
    if (official && !officialHosts.includes(hostname)) {
      throw new EndpointPolicyError('ENDPOINT_HOST_NOT_ALLOWED');
    }

    const explicitPort = Boolean(parsed.port);
    const standardPort = (parsed.protocol === 'https:' && port === 443) || (parsed.protocol === 'http:' && port === 80);
    const allowlisted = endpointAllowlistEntry(hostname, port).some((entry) => this.allowlist.has(entry));
    if (this.environment === 'production' && !official) {
      if (!this.allowPrivateEndpoints && !allowlisted) {
        throw new EndpointPolicyError('CUSTOM_ENDPOINT_DISABLED');
      }
      if (!allowlisted) throw new EndpointPolicyError('ENDPOINT_HOST_NOT_ALLOWED');
    }
    if (explicitPort && !standardPort && !allowlisted && !(this.environment !== 'production' &&
      (hostname === 'localhost' || (isIP(hostname) !== 0 && isLoopbackAddress(hostname))))) {
      throw new EndpointPolicyError('ENDPOINT_PORT_NOT_ALLOWED');
    }
    if (hostname.endsWith('.local') || hostname === 'localhost') {
      if (this.environment === 'production' || (parsed.protocol === 'https:' && !allowlisted && !this.allowPrivateEndpoints)) {
        throw new EndpointPolicyError('ENDPOINT_PRIVATE_ADDRESS');
      }
    }

    const literal = isIP(hostname) !== 0;
    let addresses: EndpointAddress[];
    if (literal) {
      addresses = [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
    } else if (context.allowReservedTestHost && isReservedTestHost(hostname)) {
      addresses = [];
    } else {
      try {
        addresses = await this.lookup(hostname);
      } catch {
        if (context.allowReservedTestHost && isReservedTestHost(hostname)) addresses = [];
        else throw new EndpointPolicyError('ENDPOINT_DNS_FAILED');
      }
    }
    const localDevelopmentHttp = this.environment !== 'production' && parsed.protocol === 'http:';
    if (addresses.some((entry) => isForbiddenAddress(entry.address)) &&
      !(localDevelopmentHttp && addresses.length > 0 && addresses.every((entry) => isLoopbackAddress(entry.address)))) {
      throw new EndpointPolicyError('ENDPOINT_PRIVATE_ADDRESS');
    }
    if (!addresses.length && this.environment === 'production') {
      throw new EndpointPolicyError('ENDPOINT_DNS_FAILED');
    }

    parsed.hostname = hostname;
    parsed.port = standardPort ? '' : String(port);
    return {
      url: parsed.toString(),
      origin: parsed.origin,
      hostname,
      port,
      addresses,
    };
  }

  async assertAllowed(endpoint: string, context?: EndpointValidationContext): Promise<ValidatedEndpoint> {
    return this.validate(endpoint, context);
  }
}

export const validateEndpoint = (
  endpoint: string,
  options?: EndpointPolicyOptions,
  context?: EndpointValidationContext,
): Promise<ValidatedEndpoint> => new EndpointPolicy(options).validate(endpoint, context);
