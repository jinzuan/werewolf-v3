import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EndpointPolicy } from '../security/endpointPolicy';
import { migrateLegacySecrets } from '../security/secretMigration';
import { InMemoryCredentialStore } from '../security/roomCredentialStore';

test('legacy AI credentials migrate to a ref and never remain in the active room file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ww-migration-'));
  const file = path.join(directory, 'rooms.json');
  const backup = path.join(directory, 'rooms.legacy.bak');
  const legacy = [{
    id: 'room-1', code: 'ABC123', name: 'legacy', joinToken: 'join', omniscientToken: 'omni',
    hostId: 'host', maxPlayers: 1, status: 'waiting', auto: false, debugMode: false,
    members: [], players: [], createdAt: Date.now(),
    config: {
      mode: 'mixed', visibility: 'invite_only', maxPlayers: 1, minHumanPlayers: 1,
      aiFillPolicy: 'none', computerSeats: 0, roleSetup: { wolf: 0, seer: 0, witch: 0, hunter: 0, guardian: 0, villager: 1 },
      rulesetId: 'werewolf.v3.default-12p', rulesetVersion: '3.0.0-stage1', catalogVersion: 'v3.1',
      readyPolicy: 'all_connected_humans', allowPublicSpectators: false,
      aiConfig: {
        provider: 'custom', model: 'test-model', endpoint: 'http://127.0.0.1:1234/v1',
        apiKey: 'canary-api-key', token: 'canary-token', temperature: .7, maxTokens: 256, behavior: 'random',
      },
    },
  }];
  await import('node:fs/promises').then(({ writeFile }) => writeFile(file, JSON.stringify(legacy), 'utf8'));
  const store = new InMemoryCredentialStore();
  const result = await migrateLegacySecrets({
    inputPath: file,
    backupPath: backup,
    namespace: 'test',
    store,
    endpointPolicy: new EndpointPolicy({ environment: 'test', resolveDns: false }),
  });
  assert.equal(result.migratedRooms, 1);
  const active = await readFile(file, 'utf8');
  assert.doesNotMatch(active, /canary-api-key|canary-token/);
  assert.match(active, /credentialRef/);
  assert.deepEqual(await store.get({ namespace: 'test', roomCode: 'ABC123' }, result.credentialRefs[0]), {
    apiKey: 'canary-api-key', token: 'canary-token',
  });
});
