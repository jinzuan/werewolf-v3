import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { DeterministicAIProvider } from '../ai/deterministicProvider';
import { EndpointPolicy } from '../security/endpointPolicy';
import { InMemoryCredentialStore } from '../security/roomCredentialStore';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';
import { getAIProviderCapability } from '../../shared/aiProviderCapabilities';
import type { AIProvider } from '../ai/types';

test('provider capability and injected endpoint are the same runtime contract', async () => {
  let injectedEndpoint: string | undefined;
  const repository = new InMemoryRoomRepository();
  const rooms = new RoomService(repository, new InMemoryEventStore(), {
    autoDrive: false,
    credentialStore: new InMemoryCredentialStore(),
    credentialNamespace: 'endpoint-test',
    endpointPolicy: new EndpointPolicy({ environment: 'test', resolveDns: false }),
    aiProviderFactory: (_config, options): AIProvider => {
      injectedEndpoint = options.endpoint;
      return new DeterministicAIProvider();
    },
  });
  const catalog = rooms.getCatalog();
  const preset = catalog.rolePresets.find((item) => item.enabled)!;
  const endpoint = 'http://127.0.0.1:1234/v1/chat/completions';
  const created = await rooms.create({
    actorId: 'host',
    options: {
      catalogVersion: catalog.catalogVersion,
      roomName: 'endpoint wiring',
      creator: { name: 'Host', avatarId: 'avatar-player' },
      mode: 'mixed', visibility: 'invite_only', maxPlayers: preset.playerCount,
      minHumanPlayers: 1, computerSeats: preset.playerCount - 1, aiFillPolicy: 'fixed',
      roleSetup: { ...preset.roleSetup }, rolePresetId: preset.id,
      rulesetId: preset.rulesetId, rulesetVersion: preset.rulesetVersion,
      readyPolicy: 'all_connected_humans', allowPublicSpectators: false, reviewEnabled: false,
      aiConfig: {
        provider: 'custom', model: 'wired-model', endpoint,
        apiKey: 'test-key', temperature: .7, maxTokens: 256, behavior: 'random',
      },
    },
  });
  assert.equal(getAIProviderCapability('custom').endpointMode, 'configurable');
  const record = await rooms.getRecord(created.room.code);
  const provider = await (rooms as unknown as {
    providerForRoom: (room: typeof record) => Promise<AIProvider>;
  }).providerForRoom(record);
  assert.ok(provider);
  assert.equal(injectedEndpoint, endpoint);
  assert.equal(record?.config?.aiProviderConfig?.endpoint, endpoint);
  await rooms.close();
});

test('fixed providers reject a silently ignored endpoint override', async () => {
  const rooms = new RoomService(
    new InMemoryRoomRepository(),
    new InMemoryEventStore(),
    {
      credentialStore: new InMemoryCredentialStore(),
      credentialNamespace: 'endpoint-test',
      endpointPolicy: new EndpointPolicy({ environment: 'test', resolveDns: false }),
      autoDrive: false,
    },
  );
  const catalog = rooms.getCatalog();
  const preset = catalog.rolePresets.find((item) => item.enabled)!;
  await assert.rejects(
    () => rooms.create({
      actorId: 'host',
      options: {
        catalogVersion: catalog.catalogVersion,
        roomName: 'fixed endpoint',
        creator: { name: 'Host', avatarId: 'avatar-player' },
        mode: 'mixed', visibility: 'invite_only', maxPlayers: preset.playerCount,
        minHumanPlayers: 1, computerSeats: preset.playerCount - 1, aiFillPolicy: 'fixed',
        roleSetup: { ...preset.roleSetup }, rolePresetId: preset.id,
        rulesetId: preset.rulesetId, rulesetVersion: preset.rulesetVersion,
        readyPolicy: 'all_connected_humans', allowPublicSpectators: false, reviewEnabled: false,
        aiConfig: {
          provider: 'siliconflow', model: 'wired-model', endpoint: 'https://attacker.example/v1/chat/completions',
          apiKey: 'test-key', temperature: .7, maxTokens: 256, behavior: 'random',
        },
      },
    }),
    (error: unknown) => error instanceof Error &&
      (error as { code?: string }).code === 'AI_ENDPOINT_NOT_ALLOWED',
  );
  await rooms.close();
});
