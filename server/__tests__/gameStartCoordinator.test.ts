import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import {
  GameStartCoordinator,
  GameStartError,
  type GameStartResult,
} from '../rooms/gameStartCoordinator';
import { InMemoryRoomRepository } from '../rooms/repository';
import { buildRoleDeck, RoleDeckError } from '../rooms/roleDeckBuilder';
import type { RoomRecord } from '../rooms/types';

const roleSetup = {
  wolf: 1,
  seer: 1,
  witch: 0,
  hunter: 0,
  guardian: 0,
  villager: 2,
} as const;

const roomRecord = (): RoomRecord => ({
  id: 'room-start',
  code: 'START1',
  name: 'Start room',
  joinToken: 'private',
  omniscientToken: 'private-omniscient',
  hostId: 'host',
  maxPlayers: 4,
  status: 'ready_check',
  auto: false,
  debugMode: false,
  configLocked: true,
  roomRevision: 1,
  configRevision: 1,
  config: {
    mode: 'mixed',
    visibility: 'invite_only',
    maxPlayers: 4,
    minHumanPlayers: 1,
    aiFillPolicy: 'fixed',
    computerSeats: 3,
    roleSetup: { ...roleSetup },
    rulesetId: 'werewolf.v3.default-12p',
    rulesetVersion: '3.0.0-stage1',
    catalogVersion: 'v31-test',
    readyPolicy: 'all_connected_humans',
    allowPublicSpectators: false,
    rulesetAvailable: true,
  },
  members: [
    {
      id: 'host',
      name: 'Host',
      kind: 'player',
      connected: true,
      omniscient: false,
      resumeToken: 'resume',
      seatIndex: 0,
      isAI: false,
      ready: true,
      avatarId: 'avatar-player',
    },
  ],
  players: [],
  createdAt: 1,
  updatedAt: 1,
});

const coordinatorFor = (
  repository: InMemoryRoomRepository,
  eventStore = new InMemoryEventStore(),
  extra: Partial<ConstructorParameters<typeof GameStartCoordinator>[1]> = {},
) =>
  new GameStartCoordinator(repository, {
    eventStore,
    randomIndex: () => 0,
    ...extra,
  });

test('role deck expands persisted roleSetup and shuffles with the secure seam', () => {
  const deck = buildRoleDeck(roleSetup, 4, () => 0);
  assert.equal(deck.length, 4);
  assert.deepEqual(
    deck.sort(),
    ['wolf', 'seer', 'villager', 'villager'].sort(),
  );
  assert.throws(
    () => buildRoleDeck({ ...roleSetup, villager: 1 }, 4, () => 0),
    (error: unknown) =>
      error instanceof RoleDeckError && error.code === 'ROLE_COUNT_MISMATCH',
  );
});

test('start CAS fills exactly the configured AI seats and deals persisted setup', async () => {
  const repository = new InMemoryRoomRepository([roomRecord()]);
  const coordinator = coordinatorFor(repository);
  const result = await coordinator.start('START1', {
    commandId: 'start-1',
    actorId: 'host',
    expectedRoomRevision: 1,
  });

  assert.equal(result.room.status, 'playing');
  assert.equal(result.players.length, 4);
  assert.equal(result.room.members.filter((member) => member.isAI).length, 3);
  assert.deepEqual(
    result.players.map((player) => player.role).sort(),
    ['seer', 'villager', 'villager', 'wolf'].sort(),
  );
  assert.equal(result.room.config?.roleSetup.villager, 2);
  assert.ok(result.room.gameId);
  assert.ok(result.room.session);

  const retry = await coordinator.start('START1', {
    commandId: 'start-1',
    actorId: 'host',
    expectedRoomRevision: 1,
  });
  assert.equal(retry.cached, true);
  assert.equal(retry.gameId, result.gameId);
});

test('different concurrent start commands produce one game and one loser', async () => {
  const repository = new InMemoryRoomRepository([roomRecord()]);
  const coordinator = coordinatorFor(repository);
  const results = await Promise.allSettled([
    coordinator.start('START1', {
      commandId: 'start-a',
      actorId: 'host',
      expectedRoomRevision: 1,
    }),
    coordinator.start('START1', {
      commandId: 'start-b',
      actorId: 'host',
      expectedRoomRevision: 1,
    }),
  ]);

  const successes = results.filter(
    (result): result is PromiseFulfilledResult<GameStartResult> =>
      result.status === 'fulfilled',
  );
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.ok(failures[0].reason instanceof GameStartError);
  assert.equal(failures[0].reason.code, 'GAME_START_IN_PROGRESS');

  const room = await repository.get('START1');
  assert.equal(room?.status, 'playing');
  assert.equal(room?.members.filter((member) => member.isAI).length, 3);
  assert.equal(room?.gameId, successes[0].value.gameId);
});

test('session failure rolls starting back without fake playing or AI seats', async () => {
  const repository = new InMemoryRoomRepository([roomRecord()]);
  let statusAtInitialize: string | undefined;
  const coordinator = coordinatorFor(repository, new InMemoryEventStore(), {
    sessionFactory: () => ({
      gameId: 'never-committed',
      players: [],
      serialize: () => ({ state: {} } as never),
      initialize: async () => {
        statusAtInitialize = (await repository.get('START1'))?.status;
        throw new Error('injected session failure');
      },
      dispose: () => undefined,
    }),
  });

  await assert.rejects(
    () =>
      coordinator.start('START1', {
        commandId: 'start-fails',
        actorId: 'host',
        expectedRoomRevision: 1,
      }),
    (error: unknown) =>
      error instanceof GameStartError && error.code === 'GAME_START_FAILED',
  );

  assert.equal(statusAtInitialize, 'playing');
  const room = await repository.get('START1');
  assert.equal(room?.status, 'ready_check');
  assert.equal(room?.members.filter((member) => member.isAI).length, 0);
  assert.equal(room?.gameId, undefined);
  assert.equal(room?.session, undefined);
  assert.equal(room?.lastStartFailure?.code, 'GAME_START_FAILED');
});
