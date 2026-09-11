import { randomUUID } from 'node:crypto';

export interface CredentialScope {
  namespace?: string;
  roomCode: string;
  credentialRef?: string;
}

export interface RoomCredentialValues {
  bearerCredential?: string;
  /** @deprecated Read only at the legacy migration boundary. */
  apiKey?: string;
  /** @deprecated Read only at the legacy migration boundary. */
  token?: string;
}

/** Convert old key/token records to the one bearer credential, fail closed. */
export const resolveBearerCredential = (
  values: RoomCredentialValues | undefined,
): string | undefined => {
  if (!values) return undefined;
  const bearer = typeof values.bearerCredential === 'string'
    ? values.bearerCredential.trim()
    : '';
  const apiKey = typeof values.apiKey === 'string' ? values.apiKey.trim() : '';
  const token = typeof values.token === 'string' ? values.token.trim() : '';
  if (bearer && (apiKey || token)) throw new CredentialSchemaAmbiguousError();
  if (apiKey && token && apiKey !== token) throw new CredentialSchemaAmbiguousError();
  return bearer || apiKey || token || undefined;
};

export const canonicalCredentialValues = (
  values: RoomCredentialValues | undefined,
): RoomCredentialValues => {
  const bearerCredential = resolveBearerCredential(values);
  return bearerCredential ? { bearerCredential } : {};
};

export interface RoomCredentialStore {
  put(scope: CredentialScope, values: RoomCredentialValues): Promise<string>;
  put(roomCode: string, values: RoomCredentialValues, namespace?: string): Promise<string>;
  get(scope: CredentialScope, credentialRef: string): Promise<RoomCredentialValues | undefined>;
  get(roomCode: string, credentialRef: string, namespace?: string): Promise<RoomCredentialValues | undefined>;
  delete(scope: CredentialScope, credentialRef: string): Promise<void>;
  delete(roomCode: string, credentialRef: string, namespace?: string): Promise<void>;
  /** Replace the values while retaining the reference and its room binding. */
  rotate(scope: CredentialScope, credentialRef: string, values: RoomCredentialValues): Promise<string>;
  rotate(roomCode: string, credentialRef: string, values: RoomCredentialValues, namespace?: string): Promise<string>;
  /** Validate all references known to a room before a production restore. */
  assertAvailable?(scope: CredentialScope, credentialRef: string): Promise<void>;
}

export class CredentialStoreError extends Error {
  constructor(
    public readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'CredentialStoreError';
  }
}

export class CredentialSchemaAmbiguousError extends CredentialStoreError {
  constructor() {
    super('CREDENTIAL_SCHEMA_AMBIGUOUS');
    this.name = 'CredentialSchemaAmbiguousError';
  }
}

const clone = <T>(value: T): T => structuredClone(value);
const cleanScope = (scope: CredentialScope): Required<Pick<CredentialScope, 'namespace' | 'roomCode'>> => ({
  namespace: (scope.namespace ?? 'default').trim(),
  roomCode: scope.roomCode.trim().toUpperCase(),
});

const cleanValues = (values: RoomCredentialValues): RoomCredentialValues => {
  const out: RoomCredentialValues = {};
  for (const key of ['apiKey', 'token'] as const) {
    const value = values[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || value.length > 4_096) {
        throw new CredentialStoreError('INVALID_CREDENTIAL');
      }
      if (value.length > 0) out[key] = value;
    }
  }
  if (values.bearerCredential !== undefined) {
    if (typeof values.bearerCredential !== 'string' || values.bearerCredential.length > 4_096) {
      throw new CredentialStoreError('INVALID_CREDENTIAL');
    }
    if (values.bearerCredential.length > 0) out.bearerCredential = values.bearerCredential;
  }
  return out;
};

const recordKey = (scope: CredentialScope, credentialRef: string): string => {
  const normalized = cleanScope(scope);
  return `${normalized.namespace}\u0000${normalized.roomCode}\u0000${credentialRef}`;
};

export class InMemoryCredentialStore implements RoomCredentialStore {
  private readonly records = new Map<string, RoomCredentialValues>();

  async put(scopeOrRoomCode: CredentialScope | string, values: RoomCredentialValues, namespace = 'default'): Promise<string> {
    const scope = typeof scopeOrRoomCode === 'string' ? { roomCode: scopeOrRoomCode, namespace } : scopeOrRoomCode;
    const credentialRef = `cr_${randomUUID().replace(/-/g, '')}`;
    this.records.set(recordKey(scope, credentialRef), cleanValues(values));
    return credentialRef;
  }

  async get(scopeOrRoomCode: CredentialScope | string, credentialRef: string, namespace = 'default'): Promise<RoomCredentialValues | undefined> {
    const scope = typeof scopeOrRoomCode === 'string' ? { roomCode: scopeOrRoomCode, namespace } : scopeOrRoomCode;
    const value = this.records.get(recordKey(scope, credentialRef));
    return value ? clone(value) : undefined;
  }

  async delete(scopeOrRoomCode: CredentialScope | string, credentialRef: string, namespace = 'default'): Promise<void> {
    const scope = typeof scopeOrRoomCode === 'string' ? { roomCode: scopeOrRoomCode, namespace } : scopeOrRoomCode;
    this.records.delete(recordKey(scope, credentialRef));
  }

  async rotate(scopeOrRoomCode: CredentialScope | string, credentialRef: string, values: RoomCredentialValues, namespace = 'default'): Promise<string> {
    const scope = typeof scopeOrRoomCode === 'string' ? { roomCode: scopeOrRoomCode, namespace } : scopeOrRoomCode;
    const key = recordKey(scope, credentialRef);
    if (!this.records.has(key)) throw new CredentialStoreError('CREDENTIAL_NOT_FOUND');
    this.records.set(key, cleanValues(values));
    return credentialRef;
  }

  async assertAvailable(scope: CredentialScope, credentialRef: string): Promise<void> {
    if (!this.records.has(recordKey(scope, credentialRef))) {
      throw new CredentialStoreError('CREDENTIAL_NOT_FOUND');
    }
  }
}
