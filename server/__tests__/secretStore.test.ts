import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EncryptedFileCredentialStore } from '../security/encryptedFileCredentialStore';
import { InMemoryCredentialStore } from '../security/roomCredentialStore';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';
import { EndpointPolicy } from '../security/endpointPolicy';

test('encrypted credential store survives a new instance without plaintext on disk', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ww-secret-'));
  const file = path.join(directory, 'secrets.json');
  const key = randomBytes(32);
  const scope = { namespace: 'test', roomCode: 'ABC123' };
  const first = new EncryptedFileCredentialStore(file, { masterKey: key, keyId: 'k1', environment: 'test' });
  const ref = await first.put(scope, { apiKey: 'canary-api-key', token: 'canary-token' });
  const raw = await readFile(file, 'utf8');
  assert.doesNotMatch(raw, /canary-api-key|canary-token/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const second = new EncryptedFileCredentialStore(file, { masterKey: key, keyId: 'k1', environment: 'test' });
  assert.deepEqual(await second.get(scope, ref), { apiKey: 'canary-api-key', token: 'canary-token' });
  await second.rotate(scope, ref, { apiKey: 'rotated-key' });
  assert.deepEqual(await second.get(scope, ref), { apiKey: 'rotated-key' });
  await second.delete(scope, ref);
  assert.equal(await second.get(scope, ref), undefined);
});

test('wrong key cannot decrypt and memory store keeps scopes separate', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ww-secret-'));
  const file = path.join(directory, 'secrets.json');
  const scope = { namespace: 'test', roomCode: 'ABC123' };
  const ref = await new EncryptedFileCredentialStore(file, { masterKey: randomBytes(32), environment: 'test' })
    .put(scope, { apiKey: 'canary' });
  const wrong = new EncryptedFileCredentialStore(file, { masterKey: randomBytes(32), environment: 'test' });
  await assert.rejects(() => wrong.get(scope, ref));

  const memory = new InMemoryCredentialStore();
  const memoryRef = await memory.put(scope, { token: 'memory-token' });
  assert.equal((await memory.get({ namespace: 'other', roomCode: 'ABC123' }, memoryRef)), undefined);
});

test('RoomService persists only tuning/ref, restores with the same key, and deletes on dissolve', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ww-secret-room-'));
  const file = path.join(directory, 'secrets.json');
  const key = randomBytes(32);
  const store = new EncryptedFileCredentialStore(file, { masterKey: key, keyId: 'k1', environment: 'test' });
  const repository = new InMemoryRoomRepository();
  const options = {
    credentialStore: store,
    credentialNamespace: 'test',
    endpointPolicy: new EndpointPolicy({ environment: 'test', resolveDns: false }),
  };
  const first = new RoomService(repository, new InMemoryEventStore(), options);
  const catalog = first.getCatalog();
  const preset = catalog.rolePresets.find((item) => item.enabled)!;
  const created = await first.create({
    actorId: 'host',
    createRequestId: 'secret-room-create',
    options: {
      catalogVersion: catalog.catalogVersion,
      roomName: 'secret room', creator: { name: 'host', avatarId: 'avatar-player' },
      mode: 'mixed', visibility: 'invite_only', maxPlayers: preset.playerCount,
      minHumanPlayers: 1, computerSeats: preset.playerCount - 1, aiFillPolicy: 'fixed',
      roleSetup: preset.roleSetup, rolePresetId: preset.id, rulesetId: preset.rulesetId,
      rulesetVersion: preset.rulesetVersion, readyPolicy: 'all_connected_humans',
      allowPublicSpectators: false, reviewEnabled: true,
      aiConfig: {
        provider: 'custom', model: 'safe-model', endpoint: 'http://127.0.0.1:1234/v1',
        apiKey: 'service-canary', token: 'service-token', temperature: .7, maxTokens: 256, behavior: 'random',
      },
    },
  });
  const record = await first.getRecord(created.room.code);
  assert.equal(record?.config?.aiProviderConfig?.model, 'safe-model');
  assert.equal(JSON.stringify(record).includes('service-canary'), false);
  const ref = record?.config?.credentialRef;
  assert.ok(ref);
  await first.close();

  const second = new RoomService(repository, new InMemoryEventStore(), {
    ...options,
    credentialStore: new EncryptedFileCredentialStore(file, { masterKey: key, keyId: 'k1', environment: 'test' }),
  });
  assert.equal(await second.restore(), 0);
  const identity = await second.identity(created.room.code, 'host', created.credentials.resumeToken);
  await second.dissolve(identity, true, created.room.roomRevision);
  assert.equal(await store.get({ namespace: 'test', roomCode: created.room.code }, ref), undefined);
  await second.close();
});
