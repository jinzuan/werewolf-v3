import assert from 'node:assert/strict';
import test from 'node:test';

import { RULESET } from '../../src/core/rules';
import {
  CATALOG_PLAYER_COUNTS,
  CATALOG_VERSION,
  RoomConfigValidator,
  RoomCatalogService,
  RulesetRegistry,
  type CreateRoomOptionsV31,
} from '../rooms/roomCatalogService';

const service = new RoomCatalogService();

const validOptions = (): CreateRoomOptionsV31 => {
  const catalog = service.getCatalog();
  const preset = catalog.rolePresets.find((item) => item.enabled);
  assert.ok(preset);
  return {
    catalogVersion: catalog.catalogVersion,
    roomName: '  月影村·新手局  ',
    creator: { name: '  房主  ', avatarId: 'avatar-1' },
    mode: 'human',
    visibility: 'invite_only',
    maxPlayers: preset.playerCount,
    minHumanPlayers: preset.playerCount,
    computerSeats: 0,
    aiFillPolicy: 'none',
    roleSetup: { ...preset.roleSetup },
    rolePresetId: preset.id,
    rulesetId: preset.rulesetId,
    rulesetVersion: preset.rulesetVersion,
    readyPolicy: 'all_connected_humans',
    allowPublicSpectators: true,
    reviewEnabled: true,
  };
};

test('catalog exposes only the reviewed 12-player executable board', () => {
  const catalog = service.getCatalog();
  assert.deepEqual(catalog.playerCounts, [...CATALOG_PLAYER_COUNTS]);
  assert.equal(catalog.catalogVersion, CATALOG_VERSION);
  assert.deepEqual(
    catalog.rolePresets.filter((preset) => preset.enabled).map((preset) => preset.playerCount),
    [12],
  );

  const enabled = catalog.rolePresets.find((preset) => preset.enabled);
  assert.ok(enabled);
  assert.deepEqual(enabled.roleSetup, RULESET.values['game.role_setup']);
  assert.equal(enabled.rulesetId, RULESET.id);
  assert.equal(enabled.rulesetVersion, RULESET.rulesetVersion);
  assert.equal(
    catalog.rolePresets.filter((preset) => !preset.enabled).length,
    CATALOG_PLAYER_COUNTS.length - 1,
  );
});

test('catalog and registry results are defensive copies', () => {
  const first = service.getCatalog();
  first.rolePresets[0].roleSetup.wolf = 99;
  first.roleLimits.wolf.max = 99;

  const second = service.getCatalog();
  assert.notEqual(second.rolePresets[0].roleSetup.wolf, 99);
  assert.notEqual(second.roleLimits.wolf.max, 99);

  const registry = new RulesetRegistry();
  const definition = registry.get(RULESET.id, RULESET.rulesetVersion);
  assert.ok(definition);
  (definition.values as Record<string, unknown>)['game.player_count'] = 6;
  assert.equal(
    registry.get(RULESET.id, RULESET.rulesetVersion)?.values['game.player_count'],
    12,
  );
});

test('validator normalizes a valid config and keeps one role setup', () => {
  const result = new RoomConfigValidator().validate(validOptions());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.config.roleSetup, RULESET.values['game.role_setup']);
  assert.equal(result.config.catalogVersion, service.getCatalog().catalogVersion);
  assert.equal('creator' in result.config, false);
  assert.equal('roomName' in result.config, false);
});

test('validator returns field issues for role total and unsupported counts', () => {
  const invalid = validOptions();
  invalid.roleSetup = { ...invalid.roleSetup, villager: 3 };
  const roleResult = service.validateConfig(invalid);
  assert.equal(roleResult.ok, false);
  if (roleResult.ok) return;
  assert.equal(roleResult.errorCode, 'ROLE_COUNT_MISMATCH');
  assert.ok(roleResult.issues.some((item) => item.path === 'roleSetup'));

  const unsupported = validOptions();
  unsupported.maxPlayers = 10;
  const unsupportedResult = service.validateConfig(unsupported);
  assert.equal(unsupportedResult.ok, false);
  if (unsupportedResult.ok) return;
  assert.equal(unsupportedResult.errorCode, 'RULESET_UNAVAILABLE');
  assert.ok(
    unsupportedResult.issues.some((item) => item.path === 'maxPlayers'),
  );
});

test('validator rejects forged preset, unknown role, and invalid mode combinations', () => {
  const invalid = validOptions() as unknown as Record<string, unknown>;
  invalid.roleSetup = {
    ...(invalid.roleSetup as Record<string, number>),
    oracle: 1,
  };
  invalid.mode = 'quick_computer';
  invalid.minHumanPlayers = 1;
  invalid.computerSeats = 2;
  invalid.aiFillPolicy = 'fixed';

  const result = service.validateConfig(invalid);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((item) => item.path === 'roleSetup.oracle'));
  assert.ok(result.issues.some((item) => item.path === 'aiFillPolicy'));
  assert.ok(result.issues.some((item) => item.path === 'minHumanPlayers'));
  assert.ok(result.issues.some((item) => item.path === 'computerSeats'));
});
