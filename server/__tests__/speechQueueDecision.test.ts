import assert from 'node:assert/strict';
import test from 'node:test';
import type { DomainEvent } from '../../shared/events';
import type { AIRequestContext } from '../ai/types';
import {
  buildSpeechQueuePrompt,
  parseSpeechQueueDecision,
} from '../ai/speechQueueDecision';

const visibleEvent = {
  eventId: 'event-public-1',
  roomId: 'room-queue',
  gameId: 'game-queue',
  sequence: 1,
  occurredAt: 1,
  phase: 'day',
  stage: 'discussion',
  eventType: 'day.speech',
  payload: { actorId: 'other', content: '请回应你的判断。' },
  visibility: 'public_timeline',
  correlationId: 'test',
  schemaVersion: 1,
} satisfies DomainEvent;

const context = (): AIRequestContext => ({
  roomId: 'room-queue',
  gameId: 'game-queue',
  playerId: 'self',
  callId: 'queue-call',
  role: 'villager',
  phase: 'day',
  stage: 'discussion',
  stageRevision: 2,
  players: [
    {
      id: 'self', roomId: 'room-queue', name: '自己', isAI: true,
      role: 'villager', isAlive: true, isHost: false, order: 1, isReady: true,
    },
    {
      id: 'other', roomId: 'room-queue', name: '对方', isAI: true,
      role: 'wolf', isAlive: true, isHost: false, order: 2, isReady: true,
    },
  ],
  allowedActions: ['request_speech'],
  allowedCommandTypes: ['game.request_speech'],
  promptContext: {
    legalActions: ['request_speech'],
    visibleEvents: [visibleEvent],
    currentRoundSpeeches: ['对方：请回应你的判断。'],
  },
});

test('queue decision accepts only visible trigger events', () => {
  const parsed = parseSpeechQueueDecision(JSON.stringify({
    contract_version: 'speech-queue-decision.v1',
    result: 'request',
    action: 'request_speech',
    reason_code: 'direct_mention',
    trigger_event_ids: ['event-public-1'],
  }), context());
  assert.equal(parsed.ok, true);

  const hidden = parseSpeechQueueDecision(JSON.stringify({
    contract_version: 'speech-queue-decision.v1',
    result: 'request',
    action: 'request_speech',
    reason_code: 'direct_mention',
    trigger_event_ids: ['event-hidden'],
  }), context());
  assert.equal(hidden.ok, false);
});

test('decline is a valid no-command outcome and the prompt exposes no private data', () => {
  const parsed = parseSpeechQueueDecision(JSON.stringify({
    contract_version: 'speech-queue-decision.v1',
    result: 'decline',
    reason_code: 'no_new_information',
    trigger_event_ids: [],
  }), context());
  assert.deepEqual(parsed.ok && parsed.decision, {
    contract_version: 'speech-queue-decision.v1',
    result: 'decline',
    reason_code: 'no_new_information',
    trigger_event_ids: [],
  });
  const prompt = buildSpeechQueuePrompt(context());
  assert.match(prompt.user, /event-public-1/u);
  assert.doesNotMatch(prompt.user, /playerId.*other|role.*wolf/u);
});
