export const RULE_KEYS = {
  werewolfKillTie: 'roles.werewolf.kill_tie',
  witchCanSelfSave: 'roles.witch.can_self_save',
  witchCanUseBothPotionsSameNight: 'roles.witch.can_use_both_potions_same_night',
  publicDeathCauses: 'resolution.public_death_causes',
  simultaneousBothSidesCondition: 'victory.simultaneous_both_sides_condition',
  speechOrder: 'speech.speech_order',
  lastWordsScope: 'speech.last_words_scope',
  abstainAllowed: 'voting.abstain_allowed',
  tiePolicy: 'voting.tie_policy',
  repeatVoteScope: 'voting.repeat_vote_scope',
} as const;

export type ConfirmedRuleKey = (typeof RULE_KEYS)[keyof typeof RULE_KEYS];

/**
 * Stable ownership map from the serialized RuleSet key to the contract seam
 * that consumes it. Implementations should cite these symbols instead of
 * duplicating string keys.
 */
export const RULE_CODE_REFERENCES = {
  [RULE_KEYS.werewolfKillTie]: 'WolfVoteContract.killTie',
  [RULE_KEYS.witchCanSelfSave]: 'SkillTargetValidation.witchHeal',
  [RULE_KEYS.witchCanUseBothPotionsSameNight]: 'WitchActionContract.potionLimit',
  [RULE_KEYS.publicDeathCauses]: 'PublicTimelineProjection.deathAnnouncement',
  [RULE_KEYS.simultaneousBothSidesCondition]: 'VictoryContract.simultaneousResult',
  [RULE_KEYS.speechOrder]: 'SpeechContract.order',
  [RULE_KEYS.lastWordsScope]: 'SpeechContract.lastWords',
  [RULE_KEYS.abstainAllowed]: 'VoteContract.abstain',
  [RULE_KEYS.tiePolicy]: 'VoteContract.tiePolicy',
  [RULE_KEYS.repeatVoteScope]: 'VoteContract.repeatVote',
} as const satisfies Record<ConfirmedRuleKey, string>;

export type RuleCodeReference =
  (typeof RULE_CODE_REFERENCES)[ConfirmedRuleKey];
