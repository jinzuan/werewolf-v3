import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  assertSecurePath,
  atomicWriteFile,
  readSecureFile,
} from '../filePersistence';
import { EndpointPolicy, type EndpointPolicyOptions } from './endpointPolicy';
import {
  hasLegacyPlaintextCredentials,
  migrateRoomRecord,
  stripPersistedConnectionFacts,
} from '../rooms/roomMigration';
import type { RoomRecord } from '../rooms/types';
import {
  canonicalCredentialValues,
  type RoomCredentialStore,
} from './roomCredentialStore';
import { decodeSecretKey } from './encryptedFileCredentialStore';

const RECOVERY_SCHEMA_VERSION = 1;
const RECOVERY_KEY_BYTES = 32;
const RECOVERY_NONCE_BYTES = 12;

export interface SecretRecoveryOptions {
  /** Recovery packages must be below this directory and are always `.enc`. */
  secretRoot: string;
  masterKey: Uint8Array | string;
  keyId?: string;
  fileName?: string;
}

export interface SecretMigrationOptions {
  inputPath: string;
  /** Deprecated input. It can only influence the encrypted `.enc` name. */
  backupPath?: string;
  namespace: string;
  store: RoomCredentialStore;
  endpointPolicy?: EndpointPolicy;
  endpointPolicyOptions?: EndpointPolicyOptions;
  dataRoot?: string;
  recovery?: SecretRecoveryOptions;
  /** A non-secret audit document, normally kept below the secret root. */
  auditPath?: string;
}

export interface SecretMigrationResult {
  migratedRooms: number;
  /** Set only when an encrypted recovery package was explicitly requested. */
  backupPath: string | undefined;
  credentialRefs: string[];
  rotationRequiredRoomCodes: string[];
  sourceHash?: string;
}

export interface LegacyBackupScanOptions {
  dataRoot: string;
  secretRoot: string;
  namespace: string;
  store: RoomCredentialStore;
  endpointPolicy?: EndpointPolicy;
  endpointPolicyOptions?: EndpointPolicyOptions;
  /** Restrict scanning to a known room file in tests or administrative runs. */
  inputPath?: string;
  auditPath?: string;
}

export interface LegacyBackupScanResult {
  scanned: number;
  removed: number;
  migratedRooms: number;
  sourceHashes: string[];
  rotationRequiredRoomCodes: string[];
}

const legacyConfigOf = (room: RoomRecord): Record<string, unknown> | undefined => {
  const config = room.config as (RoomRecord['config'] & { aiConfig?: unknown }) | undefined;
  return config?.aiConfig && typeof config.aiConfig === 'object'
    ? config.aiConfig as Record<string, unknown>
    : undefined;
};

const absolutePath = (value: string, label: string): string => {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return path.resolve(value);
};

const sourceHashOf = (source: string): string =>
  createHash('sha256').update(source, 'utf8').digest('hex');

const recoveryAad = (namespace: string, fileName: string): Buffer =>
  Buffer.from(`werewolf-secret-recovery:${RECOVERY_SCHEMA_VERSION}:${namespace}:${fileName}`, 'utf8');

const recoveryPathOf = (
  options: SecretMigrationOptions,
): { filePath: string; secretRoot: string; key: Buffer; keyId: string } | undefined => {
  if (!options.recovery) return undefined;
  const secretRoot = absolutePath(options.recovery.secretRoot, 'secret root');
  const requestedName = (options.recovery.fileName ?? options.backupPath)
    ? path.basename(options.recovery.fileName ?? options.backupPath!)
    : `${path.basename(options.inputPath)}.legacy.enc`;
  const fileName = requestedName.endsWith('.enc')
    ? requestedName
    : requestedName.replace(/\.bak$/i, '') + '.enc';
  if (!fileName || fileName.includes(path.sep) || !fileName.endsWith('.enc')) {
    throw new Error('secret recovery package must be a .enc file in the secret root');
  }
  const filePath = path.join(secretRoot, fileName);
  assertSecurePath(filePath, secretRoot);
  const key = decodeSecretKey(options.recovery.masterKey);
  if (!key || key.length !== RECOVERY_KEY_BYTES) {
    throw new Error('secret recovery package requires a 32-byte key');
  }
  return {
    filePath,
    secretRoot,
    key,
    keyId: options.recovery.keyId?.trim() || 'default',
  };
};

const writeEncryptedRecoveryPackage = async (
  source: string,
  options: SecretMigrationOptions,
): Promise<string | undefined> => {
  const recovery = recoveryPathOf(options);
  if (!recovery) return undefined;
  const nonce = randomBytes(RECOVERY_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', recovery.key, nonce);
  const fileName = path.basename(recovery.filePath);
  cipher.setAAD(recoveryAad(options.namespace, fileName));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(source, 'utf8')), cipher.final()]);
  const document = {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    namespace: options.namespace,
    keyId: recovery.keyId,
    sourceHash: sourceHashOf(source),
    iv: nonce.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
  await atomicWriteFile(
    recovery.filePath,
    () => JSON.stringify(document, null, 2),
    { dataRoot: recovery.secretRoot },
  );
  return recovery.filePath;
};

const appendAudit = async (
  auditPath: string | undefined,
  dataRoot: string,
  entry: {
    sourceHash: string;
    roomCodes: readonly string[];
    removedFile?: string;
  },
): Promise<void> => {
  if (!auditPath) return;
  const target = absolutePath(auditPath, 'secret migration audit path');
  assertSecurePath(target, dataRoot);
  let existing: unknown[] = [];
  try {
    existing = JSON.parse(await readSecureFile(target, { dataRoot })) as unknown[];
    if (!Array.isArray(existing)) throw new Error('audit is not an array');
  } catch (error) {
    if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      existing = [];
    } else if (error instanceof SyntaxError) {
      throw new Error('secret migration audit is corrupt');
    } else if (error instanceof Error && error.message === 'audit is not an array') {
      throw error;
    } else if (error && typeof error === 'object' && (error as { code?: string }).code === 'FILE_NOT_FOUND') {
      existing = [];
    } else {
      // An unreadable audit must not be replaced by a new document.
      throw new Error('secret migration audit is unavailable');
    }
  }
  existing.push({
    schemaVersion: 1,
    sourceHash: entry.sourceHash,
    roomCodes: [...entry.roomCodes],
    ...(entry.removedFile ? { removedFile: path.basename(entry.removedFile) } : {}),
    recordedAt: Date.now(),
  });
  await atomicWriteFile(target, () => JSON.stringify(existing, null, 2), { dataRoot });
};

const migratedCredential = (
  legacyKey: string | undefined,
  legacyToken: string | undefined,
): { values: ReturnType<typeof canonicalCredentialValues>; ambiguous: boolean } => {
  const ambiguous = Boolean(legacyKey && legacyToken && legacyKey !== legacyToken);
  // Never persist both legacy aliases. Ambiguous records deliberately retain
  // no usable bearer value and are blocked until the owner rotates it.
  return {
    values: ambiguous
      ? {}
      : canonicalCredentialValues({ apiKey: legacyKey, token: legacyToken }),
    ambiguous,
  };
};

const migrateLegacyRecords = async (
  raw: unknown,
  source: string,
  options: SecretMigrationOptions,
): Promise<SecretMigrationResult> => {
  if (!Array.isArray(raw)) throw new Error('room file must contain an array');
  if (!raw.every((room) => room && typeof room === 'object')) {
    throw new Error('room file contains an invalid record');
  }
  if (!raw.some(hasLegacyPlaintextCredentials)) {
    return {
      migratedRooms: 0,
      backupPath: undefined,
      credentialRefs: [],
      rotationRequiredRoomCodes: [],
      sourceHash: sourceHashOf(source),
    };
  }

  const policy = options.endpointPolicy ?? new EndpointPolicy(options.endpointPolicyOptions);
  const sourceRooms = raw as RoomRecord[];
  const legacyByCode = new Map(sourceRooms.map((room) => [room.code.toUpperCase(), legacyConfigOf(room)]));
  const rooms = sourceRooms.map((room) => stripPersistedConnectionFacts(
    migrateRoomRecord(room, { allowLegacyPlaintextCredentials: true }),
  ));
  const refs: string[] = [];
  const rotationRequiredRoomCodes: string[] = [];
  let migratedRooms = 0;
  for (const room of rooms) {
    const legacy = legacyConfigOf(room) ?? legacyByCode.get(room.code.toUpperCase());
    if (!legacy) continue;
    const provider = legacy.provider;
    const endpoint = legacy.endpoint;
    if (typeof endpoint !== 'string' || typeof provider !== 'string') {
      throw new Error(`room ${room.code} has an invalid legacy AI configuration`);
    }
    await policy.validate(endpoint, {
      provider: provider as 'siliconflow' | 'deepseek' | 'local' | 'custom',
    });
    const legacyKey = typeof legacy.apiKey === 'string' ? legacy.apiKey : undefined;
    const legacyToken = typeof legacy.token === 'string' ? legacy.token : undefined;
    const migrated = migratedCredential(legacyKey, legacyToken);
    const ref = Object.keys(migrated.values).length > 0
      ? await options.store.put(
        { namespace: options.namespace, roomCode: room.code },
        migrated.values,
      )
      : undefined;
    const providerConfig = {
      provider,
      model: legacy.model,
      endpoint,
      temperature: legacy.temperature,
      maxTokens: legacy.maxTokens,
      behavior: legacy.behavior,
    };
    delete (room.config as Record<string, unknown>).aiConfig;
    room.config = {
      ...room.config!,
      aiProviderConfig: providerConfig,
      ...(ref ? { credentialRef: ref } : {}),
      credentialRotationRequired: true,
      ...(migrated.ambiguous ? { credentialSchemaAmbiguous: true } : {}),
    } as RoomRecord['config'];
    if (ref) refs.push(ref);
    rotationRequiredRoomCodes.push(room.code);
    migratedRooms += 1;
  }

  if (hasLegacyPlaintextCredentials(rooms)) {
    throw new Error('secret migration did not sanitize the active room records');
  }
  const dataRoot = options.dataRoot ?? path.dirname(options.inputPath);
  await atomicWriteFile(
    options.inputPath,
    () => JSON.stringify(rooms, null, 2),
    { dataRoot },
  );
  const recoveryPath = await writeEncryptedRecoveryPackage(source, options);
  await appendAudit(options.auditPath, options.recovery?.secretRoot ?? dataRoot, {
    sourceHash: sourceHashOf(source),
    roomCodes: rotationRequiredRoomCodes,
  });
  return {
    migratedRooms,
    backupPath: recoveryPath,
    credentialRefs: refs,
    rotationRequiredRoomCodes,
    sourceHash: sourceHashOf(source),
  };
};

/**
 * Convert legacy room credentials without ever writing a plaintext backup.
 * Recovery is opt-in and produces only an authenticated AES-GCM `.enc` file.
 */
export const migrateLegacySecrets = async (
  options: SecretMigrationOptions,
): Promise<SecretMigrationResult> => {
  const inputPath = absolutePath(options.inputPath, 'secret migration input path');
  const source = await readFile(inputPath, 'utf8');
  return migrateLegacyRecords(JSON.parse(source) as unknown, source, {
    ...options,
    inputPath,
  });
};

export const migrateLegacyRoomFile = migrateLegacySecrets;

const directoryFiles = async (directory: string): Promise<string[]> => {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      output.push(...await directoryFiles(target));
    } else if (entry.isFile() && entry.name.endsWith('.bak')) {
      output.push(target);
    }
  }
  return output;
};

const activePathForBackup = (backupPath: string): string => {
  const name = path.basename(backupPath);
  const activeName = name.replace(/\.pre-secret-migration\.bak$/i, '')
    .replace(/\.legacy\.bak$/i, '')
    .replace(/\.bak$/i, '');
  return path.join(path.dirname(backupPath), activeName);
};

const isMissing = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT');

/**
 * Startup/CLI cleanup for old plaintext backups. It is idempotent across a
 * crash: a sanitized active room file causes the old backup to be audited and
 * removed without importing it a second time.
 */
export const scanLegacySecretBackups = async (
  options: LegacyBackupScanOptions,
): Promise<LegacyBackupScanResult> => {
  const dataRoot = absolutePath(options.dataRoot, 'data root');
  const secretRoot = absolutePath(options.secretRoot, 'secret root');
  const requestedInput = options.inputPath
    ? absolutePath(options.inputPath, 'secret migration input path')
    : undefined;
  const candidates = requestedInput
    ? await directoryFiles(path.dirname(requestedInput))
    : await directoryFiles(dataRoot);
  const backups = candidates.filter((file) => file.endsWith('.bak') &&
    (!requestedInput || activePathForBackup(file) === requestedInput));
  const result: LegacyBackupScanResult = {
    scanned: 0,
    removed: 0,
    migratedRooms: 0,
    sourceHashes: [],
    rotationRequiredRoomCodes: [],
  };
  for (const backupPath of backups) {
    result.scanned += 1;
    const details = await lstat(backupPath);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error('plaintext secret backup is not a regular file');
    const source = await readFile(backupPath, 'utf8');
    const hash = sourceHashOf(source);
    const raw = JSON.parse(source) as unknown;
    if (!Array.isArray(raw) || !raw.some(hasLegacyPlaintextCredentials)) continue;
    const activePath = options.inputPath ? absolutePath(options.inputPath, 'secret migration input path') : activePathForBackup(backupPath);
    let activeHasLegacy = false;
    try {
      const activeSource = await readSecureFile(activePath, { dataRoot });
      activeHasLegacy = hasLegacyPlaintextCredentials(JSON.parse(activeSource) as unknown);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (activeHasLegacy || !(await lstat(activePath).then(() => true).catch(() => false))) {
      const migrated = await migrateLegacyRecords(raw, source, {
        inputPath: activePath,
        namespace: options.namespace,
        store: options.store,
        endpointPolicy: options.endpointPolicy,
        endpointPolicyOptions: options.endpointPolicyOptions,
        dataRoot,
      });
      result.migratedRooms += migrated.migratedRooms;
      result.rotationRequiredRoomCodes.push(...migrated.rotationRequiredRoomCodes);
    }
    const activeSource = await readSecureFile(activePath, { dataRoot });
    if (hasLegacyPlaintextCredentials(JSON.parse(activeSource) as unknown)) {
      throw new Error('active room file still contains legacy plaintext credentials');
    }
    await unlink(backupPath);
    await appendAudit(options.auditPath ?? path.join(secretRoot, 'legacy-secret-migration-audit.json'), secretRoot, {
      sourceHash: hash,
      roomCodes: result.rotationRequiredRoomCodes,
      removedFile: backupPath,
    });
    result.removed += 1;
    result.sourceHashes.push(hash);
  }
  result.rotationRequiredRoomCodes = [...new Set(result.rotationRequiredRoomCodes)];
  return result;
};
