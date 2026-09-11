import assert from 'node:assert/strict';
import test from 'node:test';
import type { DomainEvent, ViewerContext } from '../../shared/events';
import { PromptContextCache } from '../ai/promptContextCache';
import type { GameSession } from '../session/gameSession';

const speechEvent = (sequence: number, content: string): DomainEvent => ({
  eventId: `speech-${sequence}`,
  roomId: 'room-cache-race',
  gameId: 'game-cache-race',
  sequence,
  occurredAt: sequence,
  phase: 'day',
  stage: 'speech',
  actorId: 'speaker',
  eventType: 'day.speech',
  payload: { actorId: 'speaker', content },
  visibility: 'public_timeline',
  correlationId: `speech-${sequence}`,
  schemaVersion: 1,
});

test('cache watermark never advances past events returned by the current read', async () => {
  const first = speechEvent(1, '第一条发言');
  const second = speechEvent(2, '第二条发言');
  let available = [first];
  let firstRead = true;
  let releaseFirstRead!: () => void;
  const firstReadGate = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });
  const fakeSession = {
    gameId: 'game-cache-race',
    sequence: 1,
    eventsFor: async (_viewer: ViewerContext, afterSequence = 0): Promise<DomainEvent[]> => {
      // Capture the stream as the read starts. The second event is appended
      // while this read is waiting, so it must not be counted as observed yet.
      const snapshot = [...available];
      if (firstRead) {
        firstRead = false;
        await firstReadGate;
      }
      return snapshot.filter((event) => event.sequence > afterSequence);
    },
  };
  const session = fakeSession as unknown as GameSession;
  const viewer: ViewerContext = {
    kind: 'player',
    playerId: 'speaker',
    role: 'villager',
    isAlive: true,
  };
  const cache = new PromptContextCache();

  const firstReadPromise = cache.eventsFor(session, viewer);
  fakeSession.sequence = 2;
  available = [first, second];
  releaseFirstRead();

  assert.deepEqual(await firstReadPromise, [first]);
  assert.equal(cache.stats('game-cache-race')[0]?.afterSequence, 1);

  const eventsAfterRace = await cache.eventsFor(session, viewer);
  assert.deepEqual(eventsAfterRace, [first, second]);
  assert.equal(cache.stats('game-cache-race')[0]?.afterSequence, 2);
});
