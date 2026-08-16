import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  EventAppendRequest,
  EventStore,
  StoredEvent,
} from '../../shared/events';
import type { GameCommandMeta } from '../../shared/protocol';
import { InMemoryEventStore } from '../events/store';
import { GameSession } from '../session/gameSession';
import { createPlayers } from './fixtures';
import { FakeClock } from './fakeClock';

class FaultInjectingEventStore implements EventStore {
  readonly delegate = new InMemoryEventStore();
  failNextAppend = false;

  append(request: EventAppendRequest): Promise<StoredEvent[]> {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      return Promise.reject(new Error('INJECTED_APPEND_FAILURE'));
    }
    return this.delegate.append(request);
  }

  read(streamId: string, afterSequence?: number): Promise<StoredEvent[]> {
    return this.delegate.read(streamId, afterSequence);
  }
}

const metaFor = (
  session: GameSession,
  actorId: string,
  commandId: string,
): GameCommandMeta => ({
  commandId,
  actorId,
  sentAt: Date.now(),
  roomId: session.serialize().state.roomId,
  gameId: session.gameId,
  expectedStageRevision: session.stageRevision,
});

test('an event append failure rolls a command back before the next retry', async () => {
  const store = new FaultInjectingEventStore();
  const players = createPlayers();
  const session = new GameSession('room-1', players, store);
  await session.initialize();
  const guardian = players.find((player) => player.role === 'guardian')!;
  const before = session.serialize();
  const meta = metaFor(session, guardian.id, 'append-fails-once');

  store.failNextAppend = true;
  await assert.rejects(
    session.dispatch(meta, {
      type: 'game.skip_night',
      payload: { action: 'guard' },
    }),
    /INJECTED_APPEND_FAILURE/,
  );
  assert.deepEqual(session.serialize(), before);
  assert.equal((await store.read(`game:${session.gameId}`)).length, 2);

  const retried = await session.dispatch(meta, {
    type: 'game.skip_night',
    payload: { action: 'guard' },
  });
  assert.equal(retried.ok, true);
  assert.equal(session.serialize().state.streamVersion, 4);
});

test('a timeout append failure restores the old deadline and remains retryable', async () => {
  const clock = new FakeClock();
  const store = new FaultInjectingEventStore();
  const session = new GameSession('room-1', createPlayers(), store, undefined, {
    now: clock.now,
    scheduler: clock,
    stageDurationMs: 10,
  });
  await session.initialize();
  const before = session.serialize();

  store.failNextAppend = true;
  await clock.advance(11);
  assert.deepEqual(session.serialize(), before);
  assert.equal(clock.activeCount(), 1);

  await clock.advance(1);
  assert.ok(session.stageRevision > before.state.gameState.stageRevision!);
  assert.equal(clock.activeCount(), 1);
});

test('recovery prefers the latest event state over a stale room snapshot', async () => {
  const store = new FaultInjectingEventStore();
  const players = createPlayers();
  const first = new GameSession('room-1', players, store);
  await first.initialize();
  const staleSnapshot = first.serialize();
  const guardian = players.find((player) => player.role === 'guardian')!;
  const meta = metaFor(first, guardian.id, 'recover-after-snapshot-gap');
  await first.dispatch(meta, {
    type: 'game.skip_night',
    payload: { action: 'guard' },
  });

  const restored = new GameSession(
    'room-1',
    players,
    store,
    staleSnapshot,
  );
  await restored.initialize();
  assert.equal(restored.stageRevision, first.stageRevision);
  assert.equal(restored.serialize().state.streamVersion, first.serialize().state.streamVersion);
  assert.equal(
    restored.serialize().state.night.guardComplete,
    true,
  );

  const duplicate = await restored.dispatch(meta, {
    type: 'game.skip_night',
    payload: { action: 'guard' },
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.events.length, 2);
  assert.equal(
    (await store.read(`game:${restored.gameId}`)).length,
    first.serialize().state.streamVersion,
  );
});
