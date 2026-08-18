import assert from 'node:assert/strict';
import test from 'node:test';
import type { DomainEvent } from '../../../../shared/events';
import { dayDividerForEvent } from '../daySeparators';

const event = (
  eventType: DomainEvent['eventType'],
  day?: number,
): DomainEvent => ({
  eventId: `${eventType}-${day ?? 'none'}`,
  roomId: 'room-1',
  gameId: 'game-1',
  sequence: 1,
  occurredAt: 1,
  phase: eventType.startsWith('night') ? 'night' : 'day',
  stage: null,
  eventType,
  payload: day === undefined ? {} : { day },
  visibility: 'public_timeline',
  correlationId: 'test',
  schemaVersion: 1,
});

test('事件流只在切换天数时插入带阶段的分隔标题', () => {
  const firstSpeech = event('day.speech', 1);
  const secondSpeech = event('day.speech', 1);
  const nextDayVote = event('day.voting_started', 2);

  assert.equal(dayDividerForEvent(firstSpeech, null), '——第1天·白天讨论——');
  assert.equal(dayDividerForEvent(secondSpeech, firstSpeech), null);
  assert.equal(dayDividerForEvent(nextDayVote, secondSpeech), '——第2天·放逐投票——');
});

test('旧事件缺少 day 字段时沿用上一条事件的天数', () => {
  const firstNight = event('night.started', 3);
  const legacyEvent = event('wolf.message');

  assert.equal(dayDividerForEvent(legacyEvent, firstNight), null);
});
