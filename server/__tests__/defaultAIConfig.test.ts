import assert from 'node:assert/strict';
import test from 'node:test';
import { DeterministicAIProvider } from '../ai/deterministicProvider';
import type { ServerAIConfig } from '../ai/config';
import { loadAIConfig } from '../config';
import { InMemoryEventStore } from '../events/store';
import { EndpointPolicy } from '../security/endpointPolicy';
import { InMemoryCredentialStore } from '../security/roomCredentialStore';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';
import type { RoomRecord } from '../rooms/types';
import { createRequest } from './fixtures';

const ENV_KEYS = [
  'WEREWOLF_AI_CONFIG',
  'WW_API_TYPE',
  'WW_API_URL',
  'WW_MODEL',
  'WW_API_KEY',
] as const;

const withAIEnvironment = async (
  values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  action: () => Promise<void>,
): Promise<void> => {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await action();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test('loadAIConfig applies WW_* environment values without a JSON config file', async () => {
  await withAIEnvironment({
    WEREWOLF_AI_CONFIG: `/tmp/werewolf-v3-missing-ai-config-${process.pid}.json`,
    WW_API_TYPE: 'local',
    WW_API_URL: 'https://api.lingll.icu/v1',
    WW_MODEL: 'lingll-test-model',
    WW_API_KEY: 'lingll-test-key',
  }, async () => {
    const config = loadAIConfig();
    assert.equal(config.apiType, 'local');
    assert.equal(config.local.apiUrl, 'https://api.lingll.icu/v1/chat/completions');
    assert.equal(config.local.model, 'lingll-test-model');
    assert.equal(config.local.apiKey, 'lingll-test-key');
  });
});

test('default computer rooms use server AI settings and keep the key out of room data', async () => {
  await withAIEnvironment({
    WEREWOLF_AI_CONFIG: `/tmp/werewolf-v3-missing-ai-config-${process.pid}.json`,
    WW_API_TYPE: 'local',
    WW_API_URL: 'http://127.0.0.1:1234/v1',
    WW_MODEL: 'server-default-model',
    WW_API_KEY: 'server-default-key',
  }, async () => {
    const injected: ServerAIConfig[] = [];
    const rooms = new RoomService(
      new InMemoryRoomRepository(),
      new InMemoryEventStore(),
      {
        environment: 'test',
        autoDrive: false,
        credentialNamespace: 'default-ai-config-test',
        credentialStore: new InMemoryCredentialStore(),
        endpointPolicy: new EndpointPolicy({ environment: 'test', resolveDns: false }),
        aiProviderFactory: (config) => {
          injected.push(structuredClone(config));
          return new DeterministicAIProvider({ mode: 'test-deterministic' });
        },
      },
    );
    try {
      const created = await rooms.create({
        ...createRequest(rooms, 'host', 'default-ai-config-create', 'server default AI room', {
          mode: 'mixed',
          minHumanPlayers: 1,
          computerSeats: 11,
          aiFillPolicy: 'fixed',
        }),
      });
      const record = await rooms.getRecord(created.room.code);
      assert.equal(record?.config?.aiProviderConfig?.provider, 'local');
      assert.equal(record?.config?.aiProviderConfig?.endpoint, 'http://127.0.0.1:1234/v1/chat/completions');
      assert.equal(record?.config?.aiProviderConfig?.model, 'server-default-model');
      assert.ok(record?.config?.credentialRef);
      assert.doesNotMatch(JSON.stringify(record), /server-default-key/);
      assert.doesNotMatch(JSON.stringify(created.room), /server-default-key/);

      const privateService = rooms as unknown as {
        providerForRoom: (room: RoomRecord) => Promise<unknown>;
      };
      await privateService.providerForRoom(record as RoomRecord);
      assert.equal(injected.length, 1);
      assert.equal(injected[0].local.apiUrl, 'http://127.0.0.1:1234/v1/chat/completions');
      assert.equal(injected[0].local.model, 'server-default-model');
      assert.equal(injected[0].local.apiKey, 'server-default-key');

      const explicit = await rooms.create({
        ...createRequest(rooms, 'explicit-host', 'explicit-ai-config-create', 'explicit AI room', {
          mode: 'mixed',
          minHumanPlayers: 1,
          computerSeats: 11,
          aiFillPolicy: 'fixed',
          aiConfig: {
            provider: 'custom',
            model: 'user-selected-model',
            endpoint: 'http://127.0.0.1:1234/v1/user-selected',
            apiKey: 'user-selected-key',
            temperature: .7,
            maxTokens: 512,
            behavior: 'random',
          },
        }),
      });
      const explicitRecord = await rooms.getRecord(explicit.room.code);
      assert.equal(explicitRecord?.config?.aiProviderConfig?.provider, 'custom');
      assert.equal(explicitRecord?.config?.aiProviderConfig?.endpoint, 'http://127.0.0.1:1234/v1/user-selected');
      assert.equal(explicitRecord?.config?.aiProviderConfig?.model, 'user-selected-model');
      assert.doesNotMatch(JSON.stringify(explicitRecord), /user-selected-key|server-default-key/);
      await privateService.providerForRoom(explicitRecord as RoomRecord);
      assert.equal(injected[1].local.model, 'user-selected-model');
      assert.equal(injected[1].local.apiKey, 'user-selected-key');
    } finally {
      await rooms.close();
    }
  });
});

test('without server AI settings, default rooms retain the deterministic fallback path', async () => {
  await withAIEnvironment({
    WEREWOLF_AI_CONFIG: `/tmp/werewolf-v3-missing-ai-config-${process.pid}.json`,
    WW_API_TYPE: undefined,
    WW_API_URL: undefined,
    WW_MODEL: undefined,
    WW_API_KEY: undefined,
  }, async () => {
    const rooms = new RoomService(
      new InMemoryRoomRepository(),
      new InMemoryEventStore(),
      { environment: 'development', autoDrive: false },
    );
    try {
      const created = await rooms.create({
        ...createRequest(rooms, 'host', 'default-ai-config-fallback', 'fallback room', {
          mode: 'mixed',
          minHumanPlayers: 1,
          computerSeats: 11,
          aiFillPolicy: 'fixed',
        }),
      });
      const record = await rooms.getRecord(created.room.code);
      assert.equal(record?.config?.aiProviderConfig, undefined);
    } finally {
      await rooms.close();
    }
  });
});
