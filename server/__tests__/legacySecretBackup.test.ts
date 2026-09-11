import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EndpointPolicy } from '../security/endpointPolicy';
import { InMemoryCredentialStore } from '../security/roomCredentialStore';
import {
  migrateLegacySecrets,
  scanLegacySecretBackups,
} from '../security/secretMigration';

const legacyRoom = (credential: Record<string, string>) => [{
  id: 'room-legacy', code: 'LEGACY1', name: 'legacy', joinToken: 'join', omniscientToken: 'omni',
  hostId: 'host', maxPlayers: 1, status: 'waiting', auto: false, debugMode: false,
  members: [], players: [], createdAt: 1,
  config: {
    mode: 'mixed', visibility: 'invite_only', maxPlayers: 1, minHumanPlayers: 1,
    aiFillPolicy: 'none', computerSeats: 0,
    roleSetup: { wolf: 0, seer: 0, witch: 0, hunter: 0, guardian: 0, villager: 1 },
    rulesetId: 'werewolf.v3.default-12p', rulesetVersion: '3.0.0-stage1', catalogVersion: 'v3.1',
    readyPolicy: 'all_connected_humans', allowPublicSpectators: false,
    aiConfig: {
      provider: 'custom', model: 'model', endpoint: 'http://127.0.0.1:1234/v1',
      temperature: .7, maxTokens: 128, behavior: 'random', ...credential,
    },
  },
}];

const policy = new EndpointPolicy({ environment: 'test', resolveDns: false });

test('recovery is authenticated and never writes a plaintext .bak', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ww-secret-recovery-'));
  const secretRoot = path.join(root, 'secrets');
  await mkdir(secretRoot);
  const inputPath = path.join(root, 'rooms.json');
  await writeFile(inputPath, JSON.stringify(legacyRoom({ apiKey: 'single-canary' })));
  const result = await migrateLegacySecrets({
    inputPath,
    dataRoot: root,
    namespace: 'test',
    store: new InMemoryCredentialStore(),
    endpointPolicy: policy,
    backupPath: path.join(root, 'rooms.legacy.bak'),
    recovery: {
      secretRoot,
      masterKey: Buffer.alloc(32, 9),
      fileName: 'rooms.legacy.enc',
    },
  });
  assert.equal(result.backupPath, path.join(secretRoot, 'rooms.legacy.enc'));
  assert.match(result.backupPath, /\.enc$/);
  assert.doesNotMatch(await readFile(result.backupPath, 'utf8'), /single-canary/);
  await assert.rejects(() => access(path.join(root, 'rooms.legacy.bak')));
  assert.doesNotMatch(await readFile(inputPath, 'utf8'), /single-canary/);
});

test('legacy .bak cleanup is restart-safe and marks rooms for rotation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ww-secret-backup-'));
  const secretRoot = path.join(root, 'secrets');
  await mkdir(secretRoot);
  const inputPath = path.join(root, 'rooms.json');
  const backupPath = path.join(root, 'rooms.json.pre-secret-migration.bak');
  const source = JSON.stringify(legacyRoom({ apiKey: 'backup-canary' }));
  await writeFile(inputPath, source);
  await writeFile(backupPath, source);
  const store = new InMemoryCredentialStore();
  const result = await scanLegacySecretBackups({
    dataRoot: root,
    secretRoot,
    namespace: 'test',
    store,
    endpointPolicy: policy,
  });
  assert.equal(result.removed, 1);
  assert.deepEqual(result.rotationRequiredRoomCodes, ['LEGACY1']);
  assert.doesNotMatch(await readFile(inputPath, 'utf8'), /backup-canary/);
  await assert.rejects(() => access(backupPath));
  const second = await scanLegacySecretBackups({
    dataRoot: root,
    secretRoot,
    namespace: 'test',
    store,
    endpointPolicy: policy,
  });
  assert.deepEqual(second, {
    scanned: 0,
    removed: 0,
    migratedRooms: 0,
    sourceHashes: [],
    rotationRequiredRoomCodes: [],
  });
});
