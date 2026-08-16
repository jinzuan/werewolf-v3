import { chmod, copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../filePersistence';
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

export interface SecretMigrationOptions {
  inputPath: string;
  backupPath?: string;
  namespace: string;
  store: RoomCredentialStore;
  endpointPolicy?: EndpointPolicy;
  endpointPolicyOptions?: EndpointPolicyOptions;
}

export interface SecretMigrationResult {
  migratedRooms: number;
  backupPath: string | undefined;
  credentialRefs: string[];
}

const legacyConfigOf = (room: RoomRecord): Record<string, unknown> | undefined => {
  const config = room.config as (RoomRecord['config'] & { aiConfig?: unknown }) | undefined;
  return config?.aiConfig && typeof config.aiConfig === 'object'
    ? config.aiConfig as Record<string, unknown>
    : undefined;
};

/**
 * One-shot offline conversion for the pre-C schema. It deliberately refuses
 * to run without an explicit file, namespace and backup target, and never
 * includes credential values in its result or diagnostics.
 */
export const migrateLegacySecrets = async (
  options: SecretMigrationOptions,
): Promise<SecretMigrationResult> => {
  if (!path.isAbsolute(options.inputPath)) throw new Error('secret migration requires an absolute input path');
  const raw = JSON.parse(await readFile(options.inputPath, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error('room file must contain an array');
  if (!raw.every((room) => room && typeof room === 'object')) throw new Error('room file contains an invalid record');
  if (!raw.some(hasLegacyPlaintextCredentials)) {
    return { migratedRooms: 0, backupPath: undefined, credentialRefs: [] };
  }

  const policy = options.endpointPolicy ?? new EndpointPolicy(options.endpointPolicyOptions);
  const sourceRooms = raw as RoomRecord[];
  const legacyByCode = new Map(sourceRooms.map((room) => [room.code.toUpperCase(), legacyConfigOf(room)]));
  const rooms = sourceRooms.map((room) => stripPersistedConnectionFacts(migrateRoomRecord(room)));
  const refs: string[] = [];
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
    const ambiguous = Boolean(legacyKey && legacyToken && legacyKey !== legacyToken);
    const ref = await options.store.put(
      { namespace: options.namespace, roomCode: room.code },
      ambiguous
        ? { apiKey: legacyKey, token: legacyToken }
        : canonicalCredentialValues({ apiKey: legacyKey, token: legacyToken }),
    );
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
      credentialRef: ref,
      ...(ambiguous ? { credentialSchemaAmbiguous: true } : {}),
    } as RoomRecord['config'];
    refs.push(ref);
    migratedRooms += 1;
  }

  const backupPath = options.backupPath ?? `${options.inputPath}.pre-secret-migration.bak`;
  if (!path.isAbsolute(backupPath)) throw new Error('secret migration backup path must be absolute');
  await copyFile(options.inputPath, backupPath);
  await chmod(backupPath, 0o600);
  const saved = await atomicWriteFile(options.inputPath, () => JSON.stringify(rooms, null, 2));
  if (!saved) throw new Error('secret migration could not persist the converted room file');
  return { migratedRooms, backupPath, credentialRefs: refs };
};

export const migrateLegacyRoomFile = migrateLegacySecrets;
