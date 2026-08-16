import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { EndpointPolicy } from '../security/endpointPolicy';
import { InMemoryCredentialStore } from '../security/roomCredentialStore';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';

const makeService = () => new RoomService(
  new InMemoryRoomRepository(),
  new InMemoryEventStore(),
  {
    credentialStore: new InMemoryCredentialStore(),
    credentialNamespace: 'test',
    endpointPolicy: new EndpointPolicy({ environment: 'test', resolveDns: false }),
    autoDrive: false,
  },
);

const mixedOptions = (rooms: RoomService) => {
  const catalog = rooms.getCatalog();
  const preset = catalog.rolePresets.find((item) => item.enabled)!;
  return {
    catalogVersion: catalog.catalogVersion,
    roomName: 'AI 参数房',
    creator: { name: '房主', avatarId: 'avatar-player' },
    mode: 'mixed' as const,
    visibility: 'invite_only' as const,
    maxPlayers: preset.playerCount,
    minHumanPlayers: 1,
    computerSeats: preset.playerCount - 2,
    aiFillPolicy: 'fixed' as const,
    roleSetup: { ...preset.roleSetup },
    rolePresetId: preset.id,
    rulesetId: preset.rulesetId,
    rulesetVersion: preset.rulesetVersion,
    readyPolicy: 'all_connected_humans' as const,
    allowPublicSpectators: false,
    reviewEnabled: true,
  };
};

test('host-only AI summary and independent patch preserve, rotate, and clear secrets', async () => {
  const rooms = makeService();
  const created = await rooms.create({ actorId: 'host', createRequestId: 'ai-command-create-1', options: mixedOptions(rooms) });
  const guest = await rooms.join({
    actorId: 'guest',
    name: 'Guest',
    roomCode: created.room.code,
    joinToken: created.credentials.joinToken,
  });
  const host = await rooms.identity(created.room.code, 'host', created.credentials.resumeToken);
  const nonHost = await rooms.identity(created.room.code, 'guest', guest.credentials.resumeToken);

  assert.equal(await rooms.getAIConfig(host), null);
  await assert.rejects(() => rooms.getAIConfig(nonHost), (error: unknown) => (
    error instanceof Error && (error as { code?: string }).code === 'HOST_REQUIRED'
  ));

  const beforeUpdate = await rooms.get(created.room.code, host.actorId);
  const first = await rooms.updateAIConfig(host, {
    provider: 'custom',
    model: 'safe-model-v1',
    endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
    temperature: .4,
    maxTokens: 256,
    behavior: 'conservative',
    apiKey: 'canary-api-key',
    token: 'canary-token',
  }, beforeUpdate.roomRevision, 'ai-command-1');
  assert.equal(first.summary?.model, 'safe-model-v1');
  assert.equal(first.summary?.endpointOrigin, 'http://127.0.0.1:1234');
  assert.equal(first.summary?.hasApiKey, true);
  assert.equal(first.summary?.hasToken, true);
  assert.doesNotMatch(JSON.stringify(first), /canary-api-key|canary-token|credentialRef/);

  const record = await rooms.getRecord(created.room.code);
  assert.ok(record?.config?.credentialRef);
  assert.doesNotMatch(JSON.stringify(record), /canary-api-key|canary-token/);
  assert.doesNotMatch(JSON.stringify(created.room), /canary-api-key|canary-token|credentialRef/);

  const retried = await rooms.updateAIConfig(host, { model: 'different-but-not-replayed' }, beforeUpdate.roomRevision, 'ai-command-1');
  assert.deepEqual(retried, first);
  assert.equal((await rooms.getAIConfig(host))?.model, 'safe-model-v1');

  const changed = await rooms.updateAIConfig(host, { model: 'safe-model-v2' }, first.roomRevision, 'ai-command-2');
  assert.equal(changed.summary?.model, 'safe-model-v2');
  assert.equal(changed.summary?.hasApiKey, true);

  const clearKey = await rooms.updateAIConfig(host, { clearApiKey: true }, changed.roomRevision, 'ai-command-3');
  assert.equal(clearKey.summary?.hasApiKey, false);
  assert.equal(clearKey.summary?.hasToken, true);

  const clearToken = await rooms.updateAIConfig(host, { clearToken: true }, clearKey.roomRevision, 'ai-command-4');
  assert.equal(clearToken.summary?.hasApiKey, false);
  assert.equal(clearToken.summary?.hasToken, false);
  assert.equal((await rooms.getRecord(created.room.code))?.config?.credentialRef, undefined);

  await assert.rejects(
    () => rooms.updateAIConfig(host, { apiKey: '******', clearApiKey: true }, clearToken.roomRevision, 'ai-command-bad'),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'INVALID_ROOM_CONFIG',
  );
  await assert.rejects(
    () => rooms.updateAIConfig(nonHost, { model: 'attacker-model' }, clearToken.roomRevision, 'ai-command-attacker'),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'HOST_REQUIRED',
  );
  await rooms.close();
});

test('AI patch uses CAS and never overwrites a newer room revision', async () => {
  const rooms = makeService();
  const created = await rooms.create({ actorId: 'host', createRequestId: 'ai-command-create-2', options: mixedOptions(rooms) });
  const host = await rooms.identity(created.room.code, 'host', created.credentials.resumeToken);
  const updated = await rooms.updateAIConfig(host, {
    provider: 'custom',
    model: 'cas-model',
    endpoint: 'http://127.0.0.1:1234/v1',
  }, created.room.roomRevision, 'cas-1');
  await assert.rejects(
    () => rooms.updateAIConfig(host, { model: 'stale-model' }, created.room.roomRevision, 'cas-2'),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'ROOM_REVISION_CONFLICT',
  );
  assert.equal((await rooms.getAIConfig(host))?.model, 'cas-model');
  assert.ok(updated.roomRevision > created.room.roomRevision);
  await rooms.close();
});
