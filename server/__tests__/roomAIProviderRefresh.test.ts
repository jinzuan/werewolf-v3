import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { EndpointPolicy } from '../security/endpointPolicy';
import { InMemoryCredentialStore } from '../security/roomCredentialStore';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';

test('AI provider cache is invalidated after a waiting-room AI patch', async () => {
  const repository = new InMemoryRoomRepository();
  const rooms = new RoomService(repository, new InMemoryEventStore(), {
    credentialStore: new InMemoryCredentialStore(),
    credentialNamespace: 'test',
    endpointPolicy: new EndpointPolicy({ environment: 'test', resolveDns: false }),
    autoDrive: false,
  });
  const catalog = rooms.getCatalog();
  const preset = catalog.rolePresets.find((item) => item.enabled)!;
  const created = await rooms.create({
    actorId: 'host',
    createRequestId: 'provider-refresh-create',
    options: {
      catalogVersion: catalog.catalogVersion,
      roomName: 'provider refresh',
      creator: { name: 'Host', avatarId: 'avatar-player' },
      mode: 'mixed', visibility: 'invite_only', maxPlayers: preset.playerCount,
      minHumanPlayers: 1, computerSeats: preset.playerCount - 1, aiFillPolicy: 'fixed',
      roleSetup: { ...preset.roleSetup }, rolePresetId: preset.id,
      rulesetId: preset.rulesetId, rulesetVersion: preset.rulesetVersion,
      readyPolicy: 'all_connected_humans', allowPublicSpectators: false, reviewEnabled: true,
      aiConfig: {
        provider: 'custom', model: 'old-model', endpoint: 'http://127.0.0.1:1234/v1',
        apiKey: 'old-canary', temperature: .7, maxTokens: 256, behavior: 'random',
      },
    },
  });
  const host = await rooms.identity(created.room.code, 'host', created.credentials.resumeToken);
  const privateService = rooms as unknown as {
    providerForRoom: (room: RoomRecordLike) => Promise<unknown>;
  };
  const oldProvider = await privateService.providerForRoom(await rooms.getRecord(created.room.code) as RoomRecordLike);
  const revision = (await rooms.get(created.room.code, host.actorId)).roomRevision;
  await rooms.updateAIConfig(host, {
    model: 'new-model',
    apiKey: 'new-canary',
  }, revision, 'provider-refresh-1');
  const newProvider = await privateService.providerForRoom(await rooms.getRecord(created.room.code) as RoomRecordLike);
  assert.notEqual(newProvider, oldProvider);
  await rooms.close();
});

type RoomRecordLike = { code: string; config?: unknown };
