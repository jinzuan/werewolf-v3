import path from 'node:path';

export const RUNTIME_ENVIRONMENTS = [
  'production',
  'development',
  'test',
] as const;

export type RuntimeEnvironment = (typeof RUNTIME_ENVIRONMENTS)[number];

export interface RuntimeConfig {
  environment: RuntimeEnvironment;
  bindHost: string;
  dataDir: string;
  deploymentNamespace: string;
  roomsFile: string;
  eventsFile: string;
  reviewsFile: string;
  insightsFile: string;
  secretsDir: string;
  credentialsFile: string;
  outboxDir: string;
  waitingRoomTtlMs: number;
  endedRoomTtlMs: number;
  roomSweepIntervalMs: number;
  startupGraceMs: number;
  joinRateLimitCapacity: number;
  joinRateLimitRefillPerSecond: number;
  rateLimitStore: 'memory' | 'shared';
  instanceCount: number;
}

export interface RuntimeConfigEnv {
  WW_ENV?: string;
  WW_DATA_DIR?: string;
  WW_DEPLOYMENT_NAMESPACE?: string;
  WW_WAITING_ROOM_TTL_MS?: string;
  WW_ENDED_ROOM_TTL_MS?: string;
  WW_ROOM_SWEEP_INTERVAL_MS?: string;
  WW_ROOM_STARTUP_GRACE_MS?: string;
  WW_BIND_HOST?: string;
  WW_JOIN_RATE_LIMIT_CAPACITY?: string;
  WW_JOIN_RATE_LIMIT_REFILL_PER_SECOND?: string;
  WW_RATE_LIMIT_STORE?: string;
  WW_INSTANCE_COUNT?: string;
  WW_REPLICA_COUNT?: string;
  WW_DEPLOYMENT_REPLICAS?: string;
}

const DEFAULT_WAITING_ROOM_TTL_MS = 30 * 60 * 1000;
const DEFAULT_ENDED_ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ROOM_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_ROOM_STARTUP_GRACE_MS = 5_000;
const DEFAULT_JOIN_RATE_LIMIT_CAPACITY = 8;
const DEFAULT_JOIN_RATE_LIMIT_REFILL_PER_SECOND = 0.2;
const namespacePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const fail = (message: string): never => {
  throw new Error(`[runtime-config] ${message}`);
};

const environmentOf = (value: string | undefined): RuntimeEnvironment => {
  const environment = value ?? 'development';
  if (!(RUNTIME_ENVIRONMENTS as readonly string[]).includes(environment)) {
    fail(`WW_ENV must be production, development, or test; received ${environment}.`);
  }
  return environment as RuntimeEnvironment;
};

const absoluteDirectory = (value: string, label: string): string => {
  if (!path.isAbsolute(value)) {
    fail(`${label} must be an absolute directory.`);
  }
  const directory = path.resolve(value);
  if (directory === path.parse(directory).root) {
    fail(`${label} must be an absolute, non-root directory.`);
  }
  return directory;
};

const namespaceOf = (
  value: string | undefined,
  environment: RuntimeEnvironment,
): string => {
  const namespace = value?.trim() || environment;
  if (!namespacePattern.test(namespace)) {
    fail('WW_DEPLOYMENT_NAMESPACE contains unsupported characters.');
  }
  return namespace;
};

const durationOf = (
  value: string | undefined,
  fallback: number,
  label: string,
  allowZero = false,
): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    (allowZero ? parsed < 0 : parsed <= 0)
  ) {
    fail(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} integer in milliseconds.`);
  }
  return parsed;
};

const positiveNumberOf = (
  value: string | undefined,
  fallback: number,
  label: string,
  integer = false,
): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isSafeInteger(parsed))) {
    fail(`${label} must be a positive ${integer ? 'integer' : 'number'}.`);
  }
  return parsed;
};

/** Resolve all server-owned data paths in one place. Test processes must name
 * their temporary directory explicitly, keeping them away from formal data. */
export const resolveRuntimeConfig = (
  env: RuntimeConfigEnv = process.env,
  cwd = process.cwd(),
): RuntimeConfig => {
  const environment = environmentOf(env.WW_ENV);
  const namespace = namespaceOf(env.WW_DEPLOYMENT_NAMESPACE, environment);

  let dataDir: string;
  if (env.WW_DATA_DIR) {
    dataDir = absoluteDirectory(env.WW_DATA_DIR, 'WW_DATA_DIR');
  } else if (environment === 'production') {
    fail('production requires an explicit WW_DATA_DIR.');
  } else if (environment === 'test') {
    fail('test requires an explicit temporary WW_DATA_DIR.');
  } else {
    dataDir = path.resolve(cwd, '.data', 'dev', namespace);
  }

  if (environment === 'production' && !env.WW_DEPLOYMENT_NAMESPACE?.trim()) {
    fail('production requires an explicit WW_DEPLOYMENT_NAMESPACE.');
  }

  const rateLimitStore = (env.WW_RATE_LIMIT_STORE?.trim() || 'memory') as 'memory' | 'shared';
  if (rateLimitStore !== 'memory' && rateLimitStore !== 'shared') {
    fail('WW_RATE_LIMIT_STORE must be memory or shared.');
  }
  const instanceCount = positiveNumberOf(
    env.WW_INSTANCE_COUNT ?? env.WW_REPLICA_COUNT ?? env.WW_DEPLOYMENT_REPLICAS,
    1,
    'WW_INSTANCE_COUNT',
    true,
  );
  if (instanceCount > 1 && rateLimitStore !== 'shared') {
    fail('multiple instances require a shared RateLimitStore; use one instance or WW_RATE_LIMIT_STORE=shared.');
  }

  return {
    environment,
    bindHost: env.WW_BIND_HOST?.trim() || '127.0.0.1',
    dataDir,
    deploymentNamespace: namespace,
    roomsFile: path.join(dataDir, 'rooms.json'),
    eventsFile: path.join(dataDir, 'events.json'),
    reviewsFile: path.join(dataDir, 'reviews.json'),
    insightsFile: path.join(dataDir, 'insights.json'),
    secretsDir: path.join(dataDir, 'secrets'),
    credentialsFile: path.join(dataDir, 'secrets', 'credentials.json'),
    outboxDir: path.join(dataDir, 'outbox'),
    waitingRoomTtlMs: durationOf(
      env.WW_WAITING_ROOM_TTL_MS,
      DEFAULT_WAITING_ROOM_TTL_MS,
      'WW_WAITING_ROOM_TTL_MS',
      true,
    ),
    endedRoomTtlMs: durationOf(
      env.WW_ENDED_ROOM_TTL_MS,
      DEFAULT_ENDED_ROOM_TTL_MS,
      'WW_ENDED_ROOM_TTL_MS',
      true,
    ),
    roomSweepIntervalMs: durationOf(
      env.WW_ROOM_SWEEP_INTERVAL_MS,
      DEFAULT_ROOM_SWEEP_INTERVAL_MS,
      'WW_ROOM_SWEEP_INTERVAL_MS',
    ),
    startupGraceMs: durationOf(
      env.WW_ROOM_STARTUP_GRACE_MS,
      DEFAULT_ROOM_STARTUP_GRACE_MS,
      'WW_ROOM_STARTUP_GRACE_MS',
      true,
    ),
    joinRateLimitCapacity: positiveNumberOf(
      env.WW_JOIN_RATE_LIMIT_CAPACITY,
      DEFAULT_JOIN_RATE_LIMIT_CAPACITY,
      'WW_JOIN_RATE_LIMIT_CAPACITY',
      true,
    ),
    joinRateLimitRefillPerSecond: positiveNumberOf(
      env.WW_JOIN_RATE_LIMIT_REFILL_PER_SECOND,
      DEFAULT_JOIN_RATE_LIMIT_REFILL_PER_SECOND,
      'WW_JOIN_RATE_LIMIT_REFILL_PER_SECOND',
    ),
    rateLimitStore,
    instanceCount,
  };
};
