import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canHunterShoot,
  validateGuardAction,
  validateHunterShot,
  validateSeerAction,
  validateWitchAction,
  validateWolfKillTarget,
  type CorePlayer,
} from '../index';

const players: CorePlayer[] = [
  { id: 'wolf', role: 'wolf', alive: true },
  { id: 'wolfMate', role: 'wolf', alive: true },
  { id: 'deadWolf', role: 'wolf', alive: false },
  { id: 'guard', role: 'guardian', alive: true },
  { id: 'seer', role: 'seer', alive: true },
  { id: 'witch', role: 'witch', alive: true },
  { id: 'hunter', role: 'hunter', alive: false },
  { id: 'villager', role: 'villager', alive: true },
];

test('werewolf may self-kill, kill a teammate, or choose an empty kill', () => {
  assert.deepEqual(validateWolfKillTarget(players, 'wolf', 'wolf', 'wolf_vote'), { ok: true });
  assert.deepEqual(validateWolfKillTarget(players, 'wolf', 'wolfMate', 'wolf_vote'), { ok: true });
  assert.equal(validateWolfKillTarget(players, 'wolf', 'deadWolf', 'wolf_vote').ok, false);
  assert.deepEqual(validateWolfKillTarget(players, 'wolf', null, 'wolf_vote'), { ok: true });
});

test('guardian may self-guard but cannot repeat the previous target', () => {
  assert.deepEqual(validateGuardAction(players, 'guard', 'guard', null, 'guard_seer'), { ok: true });
  const repeated = validateGuardAction(players, 'guard', 'villager', 'villager', 'guard_seer');
  assert.equal(repeated.ok, false);
  if (!repeated.ok) assert.equal(repeated.issues[0].code, 'consecutive_guard_forbidden');
});

test('seer cannot check self and actions require the correct stage', () => {
  assert.equal(validateSeerAction(players, 'seer', 'seer', 'guard_seer').ok, false);
  assert.equal(validateSeerAction(players, 'seer', 'wolf', 'witch').ok, false);
  assert.deepEqual(validateSeerAction(players, 'seer', 'wolf', 'guard_seer'), { ok: true });
});

test('witch may self-save but may not use both potions in one night', () => {
  assert.deepEqual(
    validateWitchAction(
      players,
      'witch',
      { useAntidote: true, poisonTargetId: null },
      { antidote: 1, poison: 1 },
      'witch',
      'witch',
    ),
    { ok: true },
  );
  const both = validateWitchAction(
    players,
    'witch',
    { useAntidote: true, poisonTargetId: 'wolf' },
    { antidote: 1, poison: 1 },
    'witch',
    'witch',
  );
  assert.equal(both.ok, false);
  if (!both.ok) assert.ok(both.issues.some((issue) => issue.code === 'both_potions_forbidden'));
});

test('witch cannot use antidote when guard blocked the kill notice', () => {
  const result = validateWitchAction(
    players,
    'witch',
    { useAntidote: true, poisonTargetId: null },
    { antidote: 1, poison: 1 },
    null,
    'witch',
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issues[0].code, 'kill_notice_unavailable');
});

test('hunter can shoot only when exiled and may skip', () => {
  assert.equal(canHunterShoot('exile'), true);
  assert.equal(canHunterShoot('poison'), false);
  assert.equal(canHunterShoot('wolf_kill'), false);
  assert.deepEqual(validateHunterShot(players, 'hunter', 'exile', 'wolf'), { ok: true });
  assert.deepEqual(validateHunterShot(players, 'hunter', 'exile', null), { ok: true });
  assert.equal(validateHunterShot(players, 'hunter', 'wolf_kill', 'wolf').ok, false);
});
