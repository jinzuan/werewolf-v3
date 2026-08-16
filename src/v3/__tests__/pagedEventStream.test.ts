import assert from 'node:assert/strict';
import test from 'node:test';
import type { DomainEvent } from '../../../shared/events';
import type { GameEventsMessage } from '../../../shared/protocol';
import { MAX_EVENT_WINDOW, mergeEventEnvelope } from '../eventStream';

const event = (sequence: number): DomainEvent => ({
  eventId: `event-${sequence}`,
  roomId: 'room-1',
  gameId: 'game-1',
  sequence,
  occurredAt: sequence,
  phase: 'day',
  stage: 'speech',
  eventType: 'day.speech',
  payload: { content: `message-${sequence}` },
  visibility: 'public_timeline',
  correlationId: `command-${sequence}`,
  schemaVersion: 1,
});

test('event stream keeps a bounded visible window while accepting paged envelopes', () => {
  const envelope: GameEventsMessage = {
    type: 'game.events',
    roomId: 'room-1',
    gameId: 'game-1',
    afterSequence: 0,
    limit: 200,
    hasMore: true,
    nextAfterSequence: 200,
    nextBeforeSequence: null,
    events: Array.from({ length: 250 }, (_, index) => event(index + 1)),
  };
  const result = mergeEventEnvelope(
    { roomId: 'room-1', gameId: 'game-1', lastSeenSeq: 0, events: [] },
    envelope,
    { kind: 'spectator', spectatorId: 'spectator-1', omniscient: false },
  );
  assert.equal(result.accepted, true);
  assert.equal(result.events.length, MAX_EVENT_WINDOW);
  assert.equal(result.events[0].sequence, 51);
  assert.equal(result.events.at(-1)?.sequence, 250);
  assert.equal(result.lastSeenSeq, 250);
});
