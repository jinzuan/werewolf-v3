import assert from 'node:assert/strict';
import test from 'node:test';
import type { DomainEvent } from '../../shared/events';
import {
  consolidate,
  createCognitionState,
  featureValue,
  prepare,
  reduce,
  reduceEvents,
  type CanonicalSpeechAct,
  type CognitionPlayer,
  type ObservedClaim,
  type SpeechAnnotation,
  type SpeechCommitment,
} from '../ai/cognition';

const players: CognitionPlayer[] = [
  { id: 'w1', role: 'wolf', isAlive: true, order: 0 },
  { id: 'w2', role: 'wolf', isAlive: true, order: 1 },
  { id: 'w3', role: 'wolf', isAlive: true, order: 2 },
  { id: 'seer', role: 'seer', isAlive: true, order: 3 },
  { id: 'a', role: 'villager', isAlive: true, order: 4 },
  { id: 'b', role: 'guardian', isAlive: true, order: 5 },
  { id: 'c', role: 'witch', isAlive: true, order: 6 },
];

const event = (
  sequence: number,
  eventType: DomainEvent['eventType'],
  payload: Record<string, unknown>,
  options: {
    eventId?: string;
    actorId?: string;
    visibility?: DomainEvent['visibility'];
    audienceIds?: string[];
  } = {},
): DomainEvent => ({
  eventId: options.eventId ?? `memory-v2-${sequence}`,
  roomId: 'room-memory-v2',
  gameId: 'game-memory-v2',
  sequence,
  occurredAt: sequence,
  phase: eventType.startsWith('wolf.') || eventType.startsWith('night.') || eventType === 'seer.result'
    ? 'night'
    : 'day',
  stage: eventType.startsWith('wolf.') ? 'wolf_discussion' : 'speech',
  ...(options.actorId ? { actorId: options.actorId } : {}),
  eventType,
  payload,
  visibility: options.visibility ?? 'public_timeline',
  ...(options.audienceIds ? { audienceIds: options.audienceIds } : {}),
  correlationId: options.eventId ?? `memory-v2-${sequence}`,
  schemaVersion: 1,
});

const claim = (
  eventId: string,
  speakerId: string,
  claimId: string,
  targetId: string,
  object: string,
  overrides: Partial<ObservedClaim> = {},
): ObservedClaim => ({
  claimId,
  eventId,
  speakerId,
  source: 'validated_ai_plan',
  speechAct: 'align',
  kind: 'inference',
  subjectId: targetId,
  targetId,
  predicate: 'alignment',
  object,
  confidence: 'high',
  evidenceRefs: [],
  certainty: 'speaker_claim',
  ...overrides,
});

const annotation = (
  eventId: string,
  speakerId: string,
  options: {
    channel?: SpeechAnnotation['channel'];
    speechAct?: CanonicalSpeechAct;
    claims?: ObservedClaim[];
    commitments?: SpeechCommitment[];
    renderedContent?: string;
  } = {},
): SpeechAnnotation => ({
  annotationVersion: 'speech-annotation.v1',
  eventId,
  speakerId,
  channel: options.channel ?? 'public',
  source: 'validated_ai_plan',
  parseStatus: 'validated',
  speechAct: options.speechAct ?? 'align',
  replyToEventId: null,
  claims: options.claims ?? [],
  mentionedPlayerIds: [],
  commitments: options.commitments ?? [],
  renderedContent: options.renderedContent ?? '仅供展示的原始发言',
});

const newState = () => createCognitionState({ gameId: 'game-memory-v2', players });

test('reduce is eventId-idempotent and owner visibility fails closed', () => {
  const publicId = 'public-role-claim';
  const publicSpeech = event(1, 'day.speech', {
    actorId: 'a',
    content: '我是预言家',
    speechAnnotation: annotation(publicId, 'a', {
      claims: [claim(publicId, 'a', 'claim-role', 'a', 'seer', { predicate: 'claims_role', kind: 'fact_claim' })],
    }),
  }, { eventId: publicId, actorId: 'a' });
  const once = reduce(newState(), publicSpeech);
  const twice = reduce(once, publicSpeech);
  assert.strictEqual(twice, once);
  assert.deepEqual(twice, once);
  assert.equal(once.ownerMemoriesById.seer.facts.orderedIds.length, 0);
  assert.equal(once.ownerMemoriesById.seer.discourse.claimIds.length, 1);

  const privateResult = event(2, 'seer.result', { targetId: 'w1', alignment: 'wolf' }, {
    actorId: 'seer',
    visibility: 'role_private',
    audienceIds: ['seer'],
  });
  const missingAudience = event(3, 'seer.result', { targetId: 'w2', alignment: 'wolf' }, {
    eventId: 'private-missing-audience',
    actorId: 'seer',
    visibility: 'role_private',
  });
  const reduced = reduceEvents(once, [privateResult, missingAudience]);
  assert.equal(reduced.ownerMemoriesById.seer.facts.orderedIds.length, 1);
  assert.equal(reduced.ownerMemoriesById.a.facts.orderedIds.length, 0);
  assert.doesNotMatch(JSON.stringify(reduced.ownerMemoriesById.a), /w1|w2/);
});

test('target-level stances separate disagreement, unexplained contradiction, and explained revision', () => {
  const firstId = 'stance-first';
  const first = event(1, 'day.speech', {
    actorId: 'a',
    speechAnnotation: annotation(firstId, 'a', {
      claims: [
        claim(firstId, 'a', 'a-c-wolf', 'c', 'wolf'),
        claim(firstId, 'a', 'a-b-good', 'b', 'good'),
      ],
    }),
  }, { eventId: firstId, actorId: 'a' });
  const otherId = 'stance-other';
  const other = event(2, 'day.speech', {
    actorId: 'b',
    speechAnnotation: annotation(otherId, 'b', {
      claims: [claim(otherId, 'b', 'b-c-good', 'c', 'good')],
    }),
  }, { eventId: otherId, actorId: 'b' });
  const contradictId = 'stance-contradict';
  const contradict = event(3, 'day.speech', {
    actorId: 'a',
    speechAnnotation: annotation(contradictId, 'a', {
      claims: [claim(contradictId, 'a', 'a-c-good', 'c', 'good')],
    }),
  }, { eventId: contradictId, actorId: 'a' });
  const reviseId = 'stance-revise';
  const revise = event(4, 'day.speech', {
    actorId: 'a',
    speechAnnotation: annotation(reviseId, 'a', {
      claims: [claim(reviseId, 'a', 'a-b-wolf-explained', 'b', 'wolf', {
        revisesClaimId: 'a-b-good',
        explanationClaimId: 'new-evidence',
      })],
    }),
  }, { eventId: reviseId, actorId: 'a' });
  const state = reduceEvents(newState(), [first, other, contradict, revise]);
  const model = state.ownerMemoriesById.seer.playerModel;
  assert.deepEqual(
    model.stanceClaimIds.map((id) => model.stancesByClaimId[id].targetId),
    ['c', 'b', 'c', 'c', 'b'],
  );
  assert.equal(model.disagreementIds.length, 1);
  assert.equal(model.disagreementsById[model.disagreementIds[0]].targetId, 'c');
  assert.equal(model.contradictionIds.length, 1);
  assert.equal(model.contradictionsById[model.contradictionIds[0]].speakerId, 'a');
  assert.equal(model.contradictionsById[model.contradictionIds[0]].targetId, 'c');
});

test('raw wolf chat never enters the attack board and agreed remains distinct from locked', () => {
  const audienceIds = ['w1', 'w2', 'w3'];
  const raw = event(1, 'wolf.message', {
    actorId: 'w1',
    content: '把这段原始狼聊直接刀进攻杀板',
  }, { actorId: 'w1', visibility: 'wolf_private', audienceIds });
  let state = reduce(newState(), raw);
  assert.equal(state.wolfAttackBoard?.featureContributionIds.length, 0);
  assert.deepEqual(state.wolfAttackBoard?.preferencesByWolf.w1, []);
  assert.doesNotMatch(JSON.stringify(state.wolfAttackBoard), /原始狼聊|刀进攻杀板/);

  for (const [index, wolfId] of audienceIds.entries()) {
    const eventId = `wolf-plan-${wolfId}`;
    state = reduce(state, event(index + 2, 'wolf.message', {
      actorId: wolfId,
      speechAnnotation: annotation(eventId, wolfId, {
        channel: 'wolf_private',
        speechAct: 'propose_kill',
        commitments: [{
          kind: 'kill',
          targetId: 'seer',
          strength: 'firm',
          polarity: 'support',
          reasonCode: 'information_power',
        }],
      }),
    }, { eventId, actorId: wolfId, visibility: 'wolf_private', audienceIds }));
  }
  assert.equal(state.wolfAttackBoard?.consensus.status, 'agreed');
  assert.equal(state.wolfAttackBoard?.consensus.targetId, 'seer');
  assert.equal(state.wolfAttackBoard?.lockedKill, null);

  const versionAtAgreement = state.wolfAttackBoard!.planVersion;
  const repeatId = 'wolf-plan-repeat';
  state = reduce(state, event(5, 'wolf.message', {
    actorId: 'w3',
    speechAnnotation: annotation(repeatId, 'w3', {
      channel: 'wolf_private',
      speechAct: 'propose_kill',
      commitments: [{
        kind: 'kill', targetId: 'seer', strength: 'firm', polarity: 'support', reasonCode: 'information_power',
      }],
    }),
  }, { eventId: repeatId, actorId: 'w3', visibility: 'wolf_private', audienceIds }));
  assert.equal(state.wolfAttackBoard?.planVersion, versionAtAgreement);

  state = reduce(state, event(6, 'wolf.kill_locked', { targetId: 'seer' }, {
    visibility: 'wolf_private',
    audienceIds,
  }));
  assert.equal(state.wolfAttackBoard?.consensus.status, 'locked');
  assert.equal(state.wolfAttackBoard?.lockedKill?.targetId, 'seer');
});

test('wolf feature contributions are bounded, source-deduplicated, and checkpoint-decayed once', () => {
  const contribution = {
    targetId: 'seer',
    feature: 'informationPower',
    value: 0.5,
    extractionConfidence: 1,
    sourceEventId: 'feature-event',
  } as const;
  const structured = event(1, 'day.speech', {
    actorId: 'a',
    cognitionContributions: Array.from({ length: 100 }, () => ({ ...contribution })),
    speechAnnotation: annotation('feature-event', 'a'),
  }, { eventId: 'feature-event', actorId: 'a' });
  const state = reduce(newState(), structured);
  const board = state.wolfAttackBoard!;
  assert.equal(board.featureContributionIds.length, 1);
  assert.equal(featureValue(board, 'seer', 'informationPower'), 0.5);
  assert.ok(board.candidatesById.seer.tacticalScore >= 0 && board.candidatesById.seer.tacticalScore <= 100);

  const checkpoint = {
    id: 'game-memory-v2:1:night_open',
    kind: 'night_open' as const,
    day: 1,
    throughSequence: 1,
    stageWindow: 2,
    alivePlayerIds: players.map((player) => player.id),
    legalWolfTargetIds: ['seer', 'a', 'b', 'c'],
  };
  const decayed = consolidate(state, checkpoint);
  assert.equal(featureValue(decayed.wolfAttackBoard!, 'seer', 'informationPower'), 0.25);
  const repeated = consolidate(decayed, checkpoint);
  assert.strictEqual(repeated, decayed);
  assert.equal(featureValue(repeated.wolfAttackBoard!, 'seer', 'informationPower'), 0.25);
});

test('night_open reconciles votes; prepare is owner-safe/read-only; dawn is idempotent', () => {
  const day = event(1, 'day.started', { day: 1 });
  const commitmentId = 'vote-commitment';
  const commitmentSpeech = event(2, 'day.speech', {
    actorId: 'a',
    day: 1,
    speechAnnotation: annotation(commitmentId, 'a', {
      commitments: [{ kind: 'vote', targetId: 'b', strength: 'firm', polarity: 'support' }],
    }),
  }, { eventId: commitmentId, actorId: 'a' });
  const result = event(3, 'day.exile_result', {
    day: 1,
    round: 1,
    voteHistory: [{ voterId: 'a', targetId: 'c' }],
  });
  const seerFact = event(4, 'seer.result', { targetId: 'w1', alignment: 'wolf' }, {
    actorId: 'seer', visibility: 'role_private', audienceIds: ['seer'],
  });
  let state = reduceEvents(newState(), [day, commitmentSpeech, result, seerFact]);
  const nightOpen = {
    id: 'game-memory-v2:1:night_open',
    kind: 'night_open' as const,
    day: 1,
    throughSequence: 4,
    stageWindow: 1,
    alivePlayerIds: players.map((player) => player.id),
    legalWolfTargetIds: ['seer', 'a', 'b', 'c'],
  };
  state = consolidate(state, nightOpen);
  const aCommitment = state.ownerMemoriesById.a.votes.commitmentsById['commitment:vote-commitment:0'];
  assert.equal(aCommitment.status, 'broken');

  const beforePrepare = structuredClone(state);
  const aPacket = prepare(state, {
    ownerId: 'a', asOfSequence: 4, stageRevision: 9, legalActions: ['vote'], legalTargetIds: ['b', 'c'], mode: 'compact',
  });
  const seerPacket = prepare(state, {
    ownerId: 'seer', asOfSequence: 4, stageRevision: 9, legalActions: ['vote'], legalTargetIds: ['b', 'c'], mode: 'compact',
  });
  assert.deepEqual(state, beforePrepare);
  assert.deepEqual(aPacket.legalTargetIds, ['b', 'c']);
  assert.equal(aPacket.commitmentOutcomes[0].status, 'broken');
  assert.equal(aPacket.facts.some((fact) => fact.kind === 'seer_alignment_result'), false);
  assert.equal(seerPacket.facts.some((fact) => fact.kind === 'seer_alignment_result'), true);

  const dawn = {
    id: 'game-memory-v2:1:dawn',
    kind: 'dawn' as const,
    day: 1,
    throughSequence: 4,
    stageWindow: 2,
    alivePlayerIds: players.map((player) => player.id),
    legalWolfTargetIds: ['seer', 'a', 'b', 'c'],
  };
  const consolidated = consolidate(state, dawn);
  const repeated = consolidate(consolidated, dawn);
  assert.strictEqual(repeated, consolidated);
  assert.equal(consolidated.wolfAttackBoard?.consensus.status, 'empty');
});
