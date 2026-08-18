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

test('a reconnect push from a future server cursor requests replay from the local watermark', () => {
  const result = mergeEventEnvelope(
    { roomId: 'room-1', gameId: 'game-1', lastSeenSeq: 10, events: [] },
    {
      type: 'game.events',
      roomId: 'room-1',
      gameId: 'game-1',
      // The server socket had already advanced its delivery cursor while the
      // browser was suspended; sequence 11 is therefore not proof that the
      // local client received sequences 11..20.
      afterSequence: 20,
      lastSequence: 21,
      events: [event(21)],
    },
    { kind: 'spectator', spectatorId: 'spectator-1', omniscient: false },
  );

  assert.equal(result.accepted, true);
  assert.equal(result.needsRecovery, true);
  assert.equal(result.lastSeenSeq, 10);
});

test('long offline history advances the watermark page by page', () => {
  const viewer = { kind: 'spectator' as const, spectatorId: 'spectator-1', omniscient: false };
  const first = mergeEventEnvelope(
    { roomId: 'room-1', gameId: 'game-1', lastSeenSeq: 40, events: [] },
    {
      type: 'game.events',
      roomId: 'room-1',
      gameId: 'game-1',
      afterSequence: 40,
      limit: 200,
      hasMore: true,
      nextAfterSequence: 240,
      nextBeforeSequence: null,
      events: Array.from({ length: 200 }, (_, index) => event(index + 41)),
    },
    viewer,
  );
  const second = mergeEventEnvelope(
    first,
    {
      type: 'game.events',
      roomId: 'room-1',
      gameId: 'game-1',
      afterSequence: 240,
      lastSequence: 250,
      limit: 200,
      hasMore: false,
      nextAfterSequence: 250,
      nextBeforeSequence: null,
      events: Array.from({ length: 10 }, (_, index) => event(index + 241)),
    },
    viewer,
  );

  assert.equal(first.needsRecovery, undefined);
  assert.equal(first.lastSeenSeq, 240);
  assert.equal(second.needsRecovery, undefined);
  assert.equal(second.lastSeenSeq, 250);
  assert.equal(second.events.at(-1)?.sequence, 250);
});
