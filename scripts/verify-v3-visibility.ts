import assert from 'node:assert/strict';
import type { DomainEvent, ViewerContext } from '../shared/events';
import { filterVisibleEvents } from '../src/v3/visibility';

const event = (
  eventType: string,
  visibility: DomainEvent['visibility'],
  audienceIds?: string[],
): DomainEvent => ({
  eventId: eventType,
  roomId: 'room-1',
  gameId: 'game-1',
  sequence: 1,
  occurredAt: 1,
  eventType,
  payload: {},
  visibility,
  audienceIds,
});

const events = [
  event('night.resolved', 'public_timeline'),
  event('seer.result', 'role_private', ['seer-1']),
  event('guardian.completed', 'role_private', ['guard-1']),
  event('wolf.message', 'wolf_private', ['wolf-1']),
  event('night.resolution_detail', 'spectator_omniscient'),
];

const publicViewer: ViewerContext = {
  kind: 'spectator',
  spectatorId: 'spectator-public',
  omniscient: false,
};
assert.deepEqual(
  filterVisibleEvents(events, publicViewer).map((item) => item.eventType),
  ['night.resolved'],
);

const omniscientViewer: ViewerContext = {
  kind: 'spectator',
  spectatorId: 'spectator-monitor',
  omniscient: true,
};
assert.equal(filterVisibleEvents(events, omniscientViewer).length, events.length);

const wolfViewer: ViewerContext = {
  kind: 'player',
  playerId: 'wolf-1',
  role: 'wolf',
};
assert.deepEqual(
  filterVisibleEvents(events, wolfViewer).map((item) => item.eventType),
  ['night.resolved', 'wolf.message'],
);

console.log('V3 visibility verification passed.');
