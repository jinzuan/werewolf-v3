import assert from 'node:assert/strict';
import test from 'node:test';
import type { DomainEvent } from '../../../shared/events';
import { chatEventsForViewer } from '../visibility';

const event = (
  sequence: number,
  eventType: DomainEvent['eventType'],
  visibility: DomainEvent['visibility'],
  audienceIds: string[] = [],
): DomainEvent => ({
  eventId: `event-${sequence}`,
  roomId: 'room-1',
  gameId: 'game-1',
  sequence,
  occurredAt: sequence,
  phase: 'night',
  stage: 'wolf_discussion',
  actorId: eventType === 'wolf.message' ? `wolf-${sequence}` : undefined,
  eventType,
  payload: { content: `狼聊-${sequence}` },
  visibility,
  audienceIds,
  correlationId: `command-${sequence}`,
  schemaVersion: 1,
});

test('狼人聊天流显示所有队友发言并按服务端序号排序', () => {
  const messages = [
    event(4, 'wolf.message', 'wolf_private', ['wolf-1', 'wolf-2']),
    event(2, 'wolf.message', 'wolf_private', ['wolf-1', 'wolf-2']),
    event(1, 'game.state_updated', 'public_timeline'),
    event(3, 'wolf.message', 'wolf_private', ['wolf-1', 'wolf-2']),
  ];

  assert.deepEqual(
    chatEventsForViewer(messages, {
      kind: 'player',
      playerId: 'wolf-1',
      role: 'wolf',
    }).map((item) => item.sequence),
    [2, 3, 4],
  );
  assert.deepEqual(
    chatEventsForViewer(messages, {
      kind: 'player',
      playerId: 'villager-1',
      role: 'villager',
    }),
    [],
  );
});
