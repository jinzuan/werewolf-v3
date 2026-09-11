import assert from 'node:assert/strict';
import test from 'node:test';
import type { DomainEvent } from '../../../shared/events';
import { chatEventsForViewer, isSpeechEvent } from '../visibility';

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

test('狼人跳过记录进入狼队聊天流且不会泄露给好人', () => {
  const skipped = event(5, 'wolf.speech_skipped', 'wolf_private', ['wolf-1', 'wolf-2']);
  skipped.actorId = 'wolf-1';
  skipped.payload = { actorId: 'wolf-1', round: 1, reason: 'AI输出未通过校验，已自动跳过' };
  assert.equal(isSpeechEvent(skipped), true);
  assert.deepEqual(
    chatEventsForViewer([skipped], { kind: 'player', playerId: 'wolf-1', role: 'wolf' }),
    [skipped],
  );
  assert.deepEqual(
    chatEventsForViewer([skipped], { kind: 'player', playerId: 'villager-1', role: 'villager' }),
    [],
  );
});
