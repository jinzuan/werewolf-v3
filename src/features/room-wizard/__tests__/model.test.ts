import assert from 'node:assert/strict';
import test from 'node:test';
import type { RoomCreationCatalog } from '../../../../shared/roomContract';
import {
  canNavigateToStep,
  clearWizardDraft,
  createInitialDraft,
  optionsFromDraft,
  readWizardDraft,
  roleSetupTotal,
  serverIssuesToWizardIssues,
  validateWizardStep,
  writeWizardDraft,
  type StorageLike,
} from '../model';

const catalog: RoomCreationCatalog = {
  catalogVersion: 'catalog-test-1',
  playerCounts: [6, 8, 9, 10, 12],
  rolePresets: [
    {
      id: 'werewolf.v3.default-6p',
      name: '6人规则准备中',
      playerCount: 6,
      roleSetup: { wolf: 0, seer: 0, witch: 0, hunter: 0, guardian: 0, villager: 0 },
      rulesetId: 'werewolf.v3.default-6p',
      rulesetVersion: '3.0.0-stage1',
      enabled: false,
      unavailableReason: 'RULESET_UNAVAILABLE',
    },
    {
      id: 'werewolf.v3.default-12p',
      name: '新手均衡',
      playerCount: 12,
      roleSetup: { wolf: 4, seer: 1, witch: 1, hunter: 1, guardian: 1, villager: 4 },
      rulesetId: 'werewolf.v3.default-12p',
      rulesetVersion: '3.0.0-stage1',
      enabled: true,
    },
  ],
  roleLimits: {
    wolf: { min: 1, max: 6 },
    seer: { min: 0, max: 1 },
    witch: { min: 0, max: 1 },
    hunter: { min: 0, max: 1 },
    guardian: { min: 0, max: 1 },
    villager: { min: 0, max: 12 },
  },
  limits: { roomNameMax: 64, displayNameMax: 32, maxSpectators: 100 },
};

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

test('initial draft copies the enabled server preset and exposes disabled counts', () => {
  const draft = createInitialDraft(catalog, '林间玩家');
  assert.equal(draft.maxPlayers, 12);
  assert.equal(draft.creator.name, '林间玩家');
  assert.deepEqual(draft.roleSetup, catalog.rolePresets[1].roleSetup);
  assert.equal(roleSetupTotal(draft.roleSetup), 12);
  assert.equal(catalog.rolePresets[0].enabled, false);
});

test('draft round-trips through session storage and can be cleared', () => {
  const storage = new MemoryStorage();
  const draft = createInitialDraft(catalog);
  writeWizardDraft(storage, draft);
  assert.deepEqual(readWizardDraft(storage), draft);
  clearWizardDraft(storage);
  assert.equal(readWizardDraft(storage), null);
});

test('local validation locates player, role, and rules errors by step', () => {
  const draft = createInitialDraft(catalog);
  const invalid = {
    ...draft,
    roomName: '',
    roleSetup: { ...draft.roleSetup, villager: 3 },
    visibility: 'listed' as const,
  };
  const issues = validateWizardStep(invalid, 'confirm', catalog);
  assert.ok(issues.some((item) => item.path === 'roomName' && item.step === 'players'));
  assert.ok(issues.some((item) => item.path === 'roleSetup' && item.step === 'roles'));
  assert.equal(issues.filter((item) => item.step === 'rules').length, 0);
});

test('forward stepper jumps are blocked until prior steps are complete', () => {
  const draft = createInitialDraft(catalog);
  assert.equal(canNavigateToStep('players', 'roles', draft, catalog), true);
  assert.equal(canNavigateToStep('players', 'confirm', draft, catalog), true);
  assert.equal(canNavigateToStep('players', 'confirm', { ...draft, roomName: '' }, catalog), false);
  assert.equal(canNavigateToStep('confirm', 'players', { ...draft, roomName: '' }, catalog), true);
});

test('options use the frozen CreateRoomOptionsV31 field contract', () => {
  const draft = createInitialDraft(catalog);
  const options = optionsFromDraft({ ...draft, roomName: '  月影村  ', creator: { ...draft.creator, name: ' 玩家 ' } });
  assert.equal(options.roomName, '月影村');
  assert.equal(options.creator.name, '玩家');
  assert.equal(options.catalogVersion, catalog.catalogVersion);
  assert.equal(options.roleSetup.wolf, 4);
  assert.equal(options.readyPolicy, 'all_connected_humans');
  assert.equal(options.reviewEnabled, true);
});

test('room creation options never carry browser-managed AI configuration', () => {
  const draft = createInitialDraft(catalog);
  const stored = new MemoryStorage();
  writeWizardDraft(stored, draft);
  const options = optionsFromDraft({ ...draft, mode: 'mixed', aiFillPolicy: 'fixed', computerSeats: 1, minHumanPlayers: 11 });

  assert.equal('aiConfig' in options, false);
  assert.doesNotMatch(JSON.stringify(readWizardDraft(stored)), /apiKey|token|credential|secret/i);
});

test('server field issues map to a safe Chinese message and the correct block', () => {
  const issues = serverIssuesToWizardIssues([
    { path: 'roleSetup.wolf', messageKey: 'room.config.role_count_above_max', params: { max: 6 }, errorCode: 'INVALID_ROOM_CONFIG' },
    { path: 'visibility', messageKey: 'room.config.visibility_invalid', errorCode: 'INVALID_ROOM_CONFIG' },
  ]);
  assert.equal(issues[0].step, 'roles');
  assert.equal(issues[0].message, '该角色最多6个');
  assert.equal(issues[1].step, 'rules');
  assert.equal(issues[1].message.includes('visibility'), false);
});
