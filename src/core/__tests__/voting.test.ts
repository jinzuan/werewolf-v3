import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSpeechOrder,
  getExileVoteEligibility,
  getLastWordsEligibility,
  resolveExileVote,
  resolveWolfVote,
  validateVoteChoice,
  type CorePlayer,
} from '../index';

const players: CorePlayer[] = ['a', 'b', 'c', 'd'].map((id) => ({
  id,
  role: id === 'a' ? 'wolf' : 'villager',
  alive: true,
}));

test('wolf kill tie randomly locks one tied leader without revote or empty kill', () => {
  const ballots = [
    { voterId: 'wolf-1', targetId: 'b' },
    { voterId: 'wolf-2', targetId: 'c' },
    { voterId: 'wolf-3', targetId: 'd' },
    { voterId: 'wolf-4', targetId: null },
  ];
  const tiedTargets = new Set(['b', 'c', 'd']);
  const selectedTargets = new Set(
    [0, 0.34, 0.67, 0.999999].map((randomValue) => {
      const result = resolveWolfVote(ballots, () => randomValue);
      assert.equal(result.status, 'kill_locked');
      assert.notEqual(result.targetId, null);
      assert.equal(tiedTargets.has(result.targetId!), true);
      return result.targetId;
    }),
  );

  assert.deepEqual([...selectedTargets].sort(), ['b', 'c', 'd']);
});

test('wolf kill tie clamps injected RNG values to the tied target set', () => {
  const ballots = [
    { voterId: 'wolf-1', targetId: 'c' },
    { voterId: 'wolf-2', targetId: 'd' },
  ];

  assert.equal(resolveWolfVote(ballots, () => -1).targetId, 'c');
  assert.equal(resolveWolfVote(ballots, () => Number.NaN).targetId, 'c');
  assert.equal(resolveWolfVote(ballots, () => 1).targetId, 'd');
});

test('all-abstain wolf vote remains an explicit empty kill', () => {
  const result = resolveWolfVote([
    { voterId: 'wolf-1', targetId: null },
    { voterId: 'wolf-2', targetId: null },
  ]);

  assert.deepEqual(result, { status: 'kill_locked', targetId: null });
});

test('first exile vote permits abstention and a tie triggers one restricted revote', () => {
  const result = resolveExileVote(players, [
    { voterId: 'a', targetId: 'c' },
    { voterId: 'b', targetId: 'd' },
    { voterId: 'c', targetId: null },
    { voterId: 'd', targetId: null },
  ], 1);

  assert.equal(result.status, 'revote_required');
  if (result.status === 'revote_required') {
    assert.deepEqual(result.candidates, ['c', 'd']);
    assert.deepEqual(result.eligibleVoterIds, ['a', 'b']);
  }
});

test('ordinary exile voting permits a living player to vote for themselves', () => {
  const eligibility = getExileVoteEligibility(players, 1);
  assert.deepEqual(
    validateVoteChoice('a', 'a', {
      eligibleVoterIds: eligibility.voterIds,
      eligibleTargetIds: eligibility.targetIds,
      abstainAllowed: eligibility.abstainAllowed,
    }),
    { ok: true },
  );
});

test('revote forbids tied candidates from voting, forbids abstention, and second tie means no exile', () => {
  const eligibility = getExileVoteEligibility(players, 2, ['c', 'd']);
  assert.deepEqual(eligibility, {
    voterIds: ['a', 'b'],
    targetIds: ['c', 'd'],
    abstainAllowed: false,
  });

  const result = resolveExileVote(players, [
    { voterId: 'a', targetId: 'c' },
    { voterId: 'b', targetId: 'd' },
    { voterId: 'c', targetId: 'd' },
    { voterId: 'd', targetId: null },
  ], 2, ['c', 'd']);
  assert.equal(result.status, 'no_exile');
});

test('vote validator rejects candidate votes and abstention during a revote', () => {
  const policy = {
    eligibleVoterIds: ['a', 'b'],
    eligibleTargetIds: ['c', 'd'],
    abstainAllowed: false,
  };
  assert.equal(validateVoteChoice('c', 'd', policy).ok, false);
  assert.equal(validateVoteChoice('a', null, policy).ok, false);
  assert.deepEqual(validateVoteChoice('a', 'c', policy), { ok: true });
});

test('only exiled players receive exactly two rounds of last words', () => {
  assert.deepEqual(getLastWordsEligibility('exile'), {
    eligible: true,
    maxRounds: 2,
    reason: 'exile_two_rounds',
  });
  assert.equal(getLastWordsEligibility('wolf_kill').eligible, false);
  assert.equal(getLastWordsEligibility('poison').eligible, false);
});

test('speech order supports either random-selected direction from a random start', () => {
  assert.deepEqual(buildSpeechOrder(['a', 'b', 'c', 'd'], 'c', 'clockwise'), ['c', 'd', 'a', 'b']);
  assert.deepEqual(
    buildSpeechOrder(['a', 'b', 'c', 'd'], 'c', 'counterclockwise'),
    ['c', 'b', 'a', 'd'],
  );
});
