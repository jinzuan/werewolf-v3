import assert from 'node:assert/strict';
import test from 'node:test';
import { createV3Application } from '../app/createV3Application';
import { resolveRuntimeConfig } from '../runtimeConfig';
import { RoomCatalogService } from '../rooms/roomCatalogService';

test('a 12 AI room advances without human commands to an ended game', async () => {
  const catalog = new RoomCatalogService().getCatalog();
  const preset = catalog.rolePresets.find((item) => item.enabled);
  assert.ok(preset);
  const application = createV3Application(
    resolveRuntimeConfig({
      WW_ENV: 'test',
      WW_DATA_DIR: '/tmp/werewolf-v3-autogame',
      WW_DEPLOYMENT_NAMESPACE: 'autogame',
    }),
    { autoDrive: true, roomOptions: { aiTimeoutMs: 100, session: { stageDurationMs: 500 } } },
  );
  await application.start();
  const created = await application.rooms.create({
    actorId: 'observer',
    createRequestId: 'auto-game-test',
    options: {
      catalogVersion: catalog.catalogVersion,
      roomName: 'Auto game',
      creator: { name: 'Observer', avatarId: 'avatar-test' },
      mode: 'quick_computer',
      visibility: 'invite_only',
      maxPlayers: 12,
      minHumanPlayers: 0,
      computerSeats: 0,
      aiFillPolicy: 'fill_to_max',
      roleSetup: { ...preset.roleSetup },
      rolePresetId: preset.id,
      rulesetId: preset.rulesetId,
      rulesetVersion: preset.rulesetVersion,
      readyPolicy: 'all_connected_humans',
      allowPublicSpectators: false,
      reviewEnabled: false,
    },
  });

  try {
    const deadline = Date.now() + 15_000;
    let record = await application.rooms.getRecord(created.room.code);
    while (record?.status !== 'ended' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      record = await application.rooms.getRecord(created.room.code);
    }
    assert.equal(record?.players.length, 12);
    assert.equal(record?.status, 'ended');
    assert.equal(record?.session?.state.gameState.phase, 'ended');
    assert.ok((record?.session?.state.gameState.day ?? 0) >= 1);
  } finally {
    await application.close();
  }
});
