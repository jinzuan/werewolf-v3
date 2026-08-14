import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeGuard,
  completeSeer,
  completeWitch,
  createNightState,
  evaluateVictory,
  lockWolfKill,
  resolveNight,
  startWolfVote,
  type CorePlayer,
  type Role,
} from '../index';

const alive = (...roles: Role[]): CorePlayer[] =>
  roles.map((role, index) => ({ id: `${role}-${index}`, role, alive: true }));

test('good wins when all werewolves are dead', () => {
  assert.deepEqual(
    evaluateVictory(alive('seer', 'villager'), { checkpoint: 'after_atomic_resolution' }),
    { winner: 'good', reason: 'all_werewolves_dead' },
  );
});

test('werewolves win by eliminating either gods or villagers', () => {
  assert.deepEqual(
    evaluateVictory(alive('wolf', 'villager'), { checkpoint: 'after_atomic_resolution' }),
    { winner: 'wolf', reason: 'all_gods_dead' },
  );
  assert.deepEqual(
    evaluateVictory(alive('wolf', 'seer'), { checkpoint: 'after_atomic_resolution' }),
    { winner: 'wolf', reason: 'all_villagers_dead' },
  );
});

test('simultaneous good and werewolf conditions are a draw', () => {
  assert.deepEqual(
    evaluateVictory([], { checkpoint: 'after_atomic_resolution' }),
    { winner: 'draw', reason: 'simultaneous_conditions' },
  );
});

test('victory rejects any checkpoint other than after atomic resolution', () => {
  assert.throws(
    () =>
      evaluateVictory(alive('wolf', 'villager'), {
        checkpoint: 'night_start',
      } as never),
    /after atomic resolution/,
  );
});

test('hunter and wolf are evaluated only after an atomic death batch', () => {
  assert.deepEqual(
    evaluateVictory(alive('wolf', 'hunter'), { checkpoint: 'after_atomic_resolution' }),
    { winner: 'wolf', reason: 'all_villagers_dead' },
  );
});

test('simultaneous night deaths are fully applied before victory is evaluated', () => {
  const before = alive('wolf', 'witch');
  let night = createNightState();
  night = completeSeer(completeGuard(night, null), null);
  night = lockWolfKill(startWolfVote(night), before[1].id);
  night = completeWitch(night, false, before[0].id);

  const resolution = resolveNight(before, night);
  assert.deepEqual(
    resolution.deaths.map((death) => death.playerId),
    [before[1].id, before[0].id],
  );
  assert.deepEqual(
    evaluateVictory(resolution.players, { checkpoint: 'after_atomic_resolution' }),
    { winner: 'draw', reason: 'simultaneous_conditions' },
  );
});
