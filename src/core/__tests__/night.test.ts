import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeGuard,
  completeSeer,
  completeWitch,
  createNightState,
  getSeerResult,
  getWitchNightView,
  lockWolfKill,
  resolveNight,
  startWolfVote,
  type CorePlayer,
} from '../index';

const players: CorePlayer[] = [
  { id: 'wolf', role: 'wolf', alive: true },
  { id: 'guard', role: 'guardian', alive: true },
  { id: 'seer', role: 'seer', alive: true },
  { id: 'witch', role: 'witch', alive: true },
  { id: 'villager', role: 'villager', alive: true },
];

test('guard and seer complete in parallel before wolf then witch then resolve', () => {
  const initial = createNightState();
  assert.equal(initial.stageRevision, 0);
  const guardDone = completeGuard(initial, 'villager');
  assert.equal(guardDone.stage, 'guard_seer');
  assert.equal(guardDone.stageRevision, 0);

  const bothDone = completeSeer(guardDone, 'wolf');
  assert.equal(bothDone.stage, 'wolf_discussion');
  assert.equal(bothDone.stageRevision, 1);

  const wolfVote = startWolfVote(bothDone);
  assert.equal(wolfVote.stage, 'wolf_vote');
  assert.equal(wolfVote.stageRevision, 2);

  const witch = lockWolfKill(wolfVote, 'villager');
  assert.equal(witch.stage, 'witch');
  assert.equal(witch.stageRevision, 3);

  const resolve = completeWitch(witch, false, null);
  assert.equal(resolve.stage, 'resolve');
  assert.equal(resolve.stageRevision, 4);
});

test('wolf kill locks directly without revote-only night state', () => {
  let state = createNightState();
  state = completeSeer(completeGuard(state, 'villager'), 'wolf');
  state = startWolfVote(state);

  state = lockWolfKill(state, 'seer');
  assert.equal(state.stage, 'witch');
  assert.equal(state.stageRevision, 3);
  assert.equal(state.actions.wolfKillTargetId, 'seer');
  assert.equal('wolfVoteRound' in state, false);
  assert.equal('wolfKillCandidates' in state, false);
});

test('successful guard blocks witch kill notice and antidote access', () => {
  const view = getWitchNightView('villager', 'villager', { antidote: 1, poison: 1 });
  assert.deepEqual(view, {
    hasKillNotice: false,
    killTargetId: null,
    canUseAntidote: false,
  });
});

test('guarded wolf kill produces a peaceful night without revealing cause', () => {
  let state = createNightState();
  state = completeSeer(completeGuard(state, 'villager'), 'wolf');
  state = lockWolfKill(startWolfVote(state), 'villager');
  state = completeWitch(state, false, null);
  const result = resolveNight(players, state);

  assert.equal(result.peacefulNight, true);
  assert.deepEqual(result.deaths, []);
  assert.deepEqual(result.publicDeaths, []);
});

test('antidote saves current unguarded kill target and poison ignores guard', () => {
  let state = createNightState();
  state = completeSeer(completeGuard(state, 'wolf'), 'wolf');
  state = lockWolfKill(startWolfVote(state), 'villager');
  state = completeWitch(state, true, 'wolf');
  const result = resolveNight(players, state);

  assert.equal(result.healedTargetId, 'villager');
  assert.deepEqual(result.deaths, [{ playerId: 'wolf', cause: 'poison' }]);
});

test('seer receives alignment only', () => {
  assert.equal(getSeerResult(players, 'wolf'), 'wolf');
  assert.equal(getSeerResult(players, 'guard'), 'good');
});
