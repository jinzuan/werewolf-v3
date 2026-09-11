import assert from 'node:assert/strict';
import test from 'node:test';

import { RULE_KEYS, RULE_VALUES, RULESET, getRuleValue } from '../index';

test('exports all 92 stable ruleset keys without unresolved values', () => {
  assert.equal(RULE_KEYS.length, 92);
  assert.equal(new Set(RULE_KEYS).size, 92);
  assert.equal(Object.keys(RULE_VALUES).length, 92);
  assert.equal(Object.values(RULE_VALUES).some((value) => value === null), false);
  assert.equal(RULESET.id, 'werewolf.v3.default-12p');
});

test('contains the ten finalized rule decisions', () => {
  assert.equal(getRuleValue('roles.werewolf.kill_tie'), '平票随机杀一个');
  assert.equal(getRuleValue('roles.witch.can_self_save'), true);
  assert.equal(getRuleValue('roles.witch.can_use_both_potions_same_night'), false);
  assert.equal(getRuleValue('resolution.public_death_causes'), false);
  assert.equal(getRuleValue('victory.simultaneous_both_sides_condition'), 'draw');
  assert.equal(getRuleValue('speech.speech_order'), 'random_clockwise_or_counterclockwise');
  assert.equal(getRuleValue('speech.last_words_scope'), 'exile_only_two_rounds');
  assert.equal(getRuleValue('speech.speech_limits').free_discussion_cycles, 2);
  assert.equal(getRuleValue('voting.eligible_targets'), 'all_alive_players_except_revote_scope');
  assert.equal(getRuleValue('voting.abstain_allowed'), true);
  assert.equal(getRuleValue('voting.tie_policy'), 'single_revote_then_no_exile');
  assert.equal(
    getRuleValue('voting.repeat_vote_scope'),
    'tied_candidates_only_candidates_cannot_vote_no_abstain_max_once',
  );
});
