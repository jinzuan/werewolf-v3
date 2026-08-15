import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  atomicWriteFile,
  assertSecurePath,
  readSecureFile,
  type AsyncAtomicWriteOptions,
} from '../filePersistence';
import {
  CredentialStoreError,
  type CredentialScope,
  type RoomCredentialStore,
  type RoomCredentialValues,
} from './roomCredentialStore';

const STORE_SCHEMA_VERSION = 1;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

interface EncryptedCredentialRecord {
  namespace: string;
  roomCode: string;
  keyId: string;
  version: number;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface PersistedCredentialStore {
  schemaVersion: number;
  records: Record<string, EncryptedCredentialRecord>;
}

export interface EncryptedFileCredentialStoreOptions {
  masterKey?: Uint8Array | string;
  /** Alias accepted by migration/test callers. */
  key?: Uint8Array | string;
  keyId?: string;
  previousKeys?: Record<string, Uint8Array | string>;
  persistence?: AsyncAtomicWriteOptions;
  dataRoot?: string;
  maxBytes?: number;
  environment?: 'production' | 'development' | 'test';
}

export class EncryptedCredentialStoreError extends CredentialStoreError {
  constructor(message: string, code: 'CREDENTIAL_STORE_UNAVAILABLE' | 'CREDENTIAL_NOT_FOUND' = 'CREDENTIAL_STORE_UNAVAILABLE') {
    super(code as 'CREDENTIAL_STORE_UNAVAILABLE' | 'CREDENTIAL_NOT_FOUND' | 'INVALID_CREDENTIAL', message);
    this.name = 'EncryptedCredentialStoreError';
  }
}

const clone = <T>(value: T): T => structuredClone(value);
const normalizedScope = (scope: CredentialScope): { namespace: string; roomCode: string } => ({
  namespace: scope.namespace.trim(),
  roomCode: scope.roomCode.trim().toUpperCase(),
});
const aadFor = (scope: CredentialScope, ref: string): Buffer => Buffer.from(
  `${scope.namespace}\u0000${scope.roomCode}\u0000${ref}\u0000${STORE_SCHEMA_VERSION}`,
  'utf8',
);

export const decodeSecretKey = (value: Uint8Array | string | undefined): Buffer | undefined => {
  if (value === undefined) return undefined;
  if (value instanceof Uint8Array) {
    if (value.byteLength !== KEY_BYTES) throw new EncryptedCredentialStoreError('WW_SECRET_KEY must be exactly 32 bytes');
    return Buffer.from(value);
  }
  if (typeof value !== 'string') throw new EncryptedCredentialStoreError('WW_SECRET_KEY must be a 32-byte key');
  const trimmed = value.trim();
  const candidates = [
    Buffer.from(trimmed, 'base64'),
    /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.alloc(0),
    Buffer.from(value, 'utf8'),
  ];
  const key = candidates.find((candidate) => candidate.length === KEY_BYTES);
  if (!key) throw new EncryptedCredentialStoreError('WW_SECRET_KEY must be exactly 32 bytes (raw, base64, or hex)');
  return key;
};

const keyringFrom = (options: EncryptedFileCredentialStoreOptions): Map<string, Buffer> => {
  const current = decodeSecretKey(options.masterKey ?? options.key);
  if (!current) throw new EncryptedCredentialStoreError('encrypted credential storage requires WW_SECRET_KEY');
  const keyId = options.keyId?.trim() || 'default';
  const keyring = new Map<string, Buffer>([[keyId, current]]);
  for (const [oldKeyId, oldKey] of Object.entries(options.previousKeys ?? {})) {
    const decoded = decodeSecretKey(oldKey);
    if (decoded) keyring.set(oldKeyId, decoded);
  }
  return keyring;
};

const emptyStore = (): PersistedCredentialStore => ({
  schemaVersion: STORE_SCHEMA_VERSION,
  records: {},
});

export class EncryptedFileCredentialStore implements RoomCredentialStore {
  private readonly keyring: Map<string, Buffer>;
  private currentKeyId: string;
  private readonly persistence: AsyncAtomicWriteOptions;
  private readonly dataRoot: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    options: EncryptedFileCredentialStoreOptions = {},
  ) {
    if (!path.isAbsolute(filePath)) throw new EncryptedCredentialStoreError('credential store path must be absolute');
    this.dataRoot = options.dataRoot ?? options.persistence?.dataRoot ?? path.dirname(filePath);
    try {
      assertSecurePath(filePath, this.dataRoot);
    } catch (error) {
      if (error instanceof EncryptedCredentialStoreError) throw error;
      throw new EncryptedCredentialStoreError('credential store path is outside its data root');
    }
    this.keyring = keyringFrom(options);
    this.currentKeyId = options.keyId?.trim() || 'default';
    this.persistence = {
      ...(options.persistence ?? {}),
      dataRoot: this.dataRoot,
      maxBytes: options.maxBytes ?? options.persistence?.maxBytes,
    };
    if (options.environment === 'production' && !this.keyring.get(this.currentKeyId)) {
      throw new EncryptedCredentialStoreError('production credential store has no active key');
    }
  }

  async put(scopeOrRoomCode: CredentialScope | string, values: RoomCredentialValues, namespace = 'default'): Promise<string> {
    const scope = typeof scopeOrRoomCode === 'string' ? { roomCode: scopeOrRoomCode, namespace } : scopeOrRoomCode;
    return this.enqueue(async () => {
      const ref = `cr_${randomBytes(24).toString('base64url')}`;
      const store = await this.load();
      store.records[ref] = this.encrypt(scope, ref, values);
      await this.save(store);
      return ref;
    });
  }

  async get(scopeOrRoomCode: CredentialScope | string, credentialRef: string, namespace = 'default'): Promise<RoomCredentialValues | undefined> {
    const scope = typeof scopeOrRoomCode === 'string' ? { roomCode: scopeOrRoomCode, namespace } : scopeOrRoomCode;
    return this.enqueue(async () => {
      const store = await this.load();
      const record = store.records[credentialRef];
      if (!record) return undefined;
      return this.decrypt(scope, credentialRef, record);
    });
  }

  async delete(scopeOrRoomCode: CredentialScope | string, credentialRef: string, namespace = 'default'): Promise<void> {
    const scope = typeof scopeOrRoomCode === 'string' ? { roomCode: scopeOrRoomCode, namespace } : scopeOrRoomCode;
    await this.enqueue(async () => {
      const store = await this.load();
      const record = store.records[credentialRef];
      if (record && (record.namespace !== normalizedScope(scope).namespace || record.roomCode !== normalizedScope(scope).roomCode)) {
        throw new EncryptedCredentialStoreError('credential reference is bound to another room', 'CREDENTIAL_NOT_FOUND');
      }
      if (!record) return;
      delete store.records[credentialRef];
      await this.save(store);
    });
  }

  async rotate(scopeOrRoomCode: CredentialScope | string, credentialRef: string, values: RoomCredentialValues, namespace = 'default'): Promise<string> {
    const scope = typeof scopeOrRoomCode === 'string' ? { roomCode: scopeOrRoomCode, namespace } : scopeOrRoomCode;
    return this.enqueue(async () => {
      const store = await this.load();
      const existing = store.records[credentialRef];
      if (!existing) throw new EncryptedCredentialStoreError('credential reference does not exist', 'CREDENTIAL_NOT_FOUND');
      const normalized = normalizedScope(scope);
      if (existing.namespace !== normalized.namespace || existing.roomCode !== normalized.roomCode) {
        throw new EncryptedCredentialStoreError('credential reference is bound to another room', 'CREDENTIAL_NOT_FOUND');
      }
      store.records[credentialRef] = this.encrypt(scope, credentialRef, values);
      await this.save(store);
      return credentialRef;
    });
  }

  async assertAvailable(scope: CredentialScope, credentialRef: string): Promise<void> {
    const values = await this.get(scope, credentialRef);
    if (!values) throw new EncryptedCredentialStoreError('credential reference cannot be decrypted', 'CREDENTIAL_NOT_FOUND');
  }

  /** Re-encrypt every record with a newly supplied active key. */
  async rotateMasterKey(newKey: Uint8Array | string, newKeyId: string): Promise<void> {
    const decoded = decodeSecretKey(newKey);
    if (!decoded || !newKeyId.trim()) throw new EncryptedCredentialStoreError('invalid replacement secret key');
    await this.enqueue(async () => {
      const store = await this.load();
      const values = Object.entries(store.records).map(([ref, record]) => ({
        ref,
        scope: { namespace: record.namespace, roomCode: record.roomCode },
        values: this.decrypt({ namespace: record.namespace, roomCode: record.roomCode }, ref, record),
      }));
      this.keyring.set(newKeyId, decoded);
      this.currentKeyId = newKeyId;
      for (const item of values) store.records[item.ref] = this.encrypt(item.scope, item.ref, item.values);
      await this.save(store);
    });
  }

  private encrypt(scope: CredentialScope, credentialRef: string, values: RoomCredentialValues): EncryptedCredentialRecord {
    const normalized = normalizedScope(scope);
    const iv = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.keyring.get(this.currentKeyId)!, iv);
    cipher.setAAD(aadFor(normalized, credentialRef));
    const plaintext = Buffer.from(JSON.stringify(values), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      namespace: normalized.namespace,
      roomCode: normalized.roomCode,
      keyId: this.currentKeyId,
      version: STORE_SCHEMA_VERSION,
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
  }

  private decrypt(scope: CredentialScope, credentialRef: string, record: EncryptedCredentialRecord): RoomCredentialValues {
    const normalized = normalizedScope(scope);
    if (record.version !== STORE_SCHEMA_VERSION || record.namespace !== normalized.namespace || record.roomCode !== normalized.roomCode) {
      throw new EncryptedCredentialStoreError('credential reference binding is invalid', 'CREDENTIAL_NOT_FOUND');
    }
    const key = this.keyring.get(record.keyId);
    if (!key) throw new EncryptedCredentialStoreError('credential key is unavailable');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64url'));
      decipher.setAAD(aadFor(normalized, credentialRef));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64url')), decipher.final()]);
      const parsed = JSON.parse(plaintext.toString('utf8')) as RoomCredentialValues;
      return clone(parsed);
    } catch {
      throw new EncryptedCredentialStoreError('credential cannot be decrypted');
    }
  }

  private async load(): Promise<PersistedCredentialStore> {
    try {
      const parsed = JSON.parse(await readSecureFile(this.filePath, {
        dataRoot: this.dataRoot,
        maxBytes: this.persistence.maxBytes,
      })) as PersistedCredentialStore;
      if (parsed.schemaVersion !== STORE_SCHEMA_VERSION || !parsed.records || typeof parsed.records !== 'object') {
        throw new EncryptedCredentialStoreError('credential store schema is unsupported');
      }
      return parsed;
    } catch (error) {
      if (error instanceof EncryptedCredentialStoreError) throw error;
      if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyStore();
      }
      throw new EncryptedCredentialStoreError('credential store file is unreadable');
    }
  }

  private async save(store: PersistedCredentialStore): Promise<void> {
    const saved = await atomicWriteFile(this.filePath, () => JSON.stringify(store, null, 2), this.persistence);
    if (!saved) throw new EncryptedCredentialStoreError('credential store write failed');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
