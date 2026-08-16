import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createV3Application } from '../app/createV3Application';
import { InMemoryEventStore } from '../events/store';
import { resolveRuntimeConfig } from '../runtimeConfig';
import { RoomCatalogService } from '../rooms/roomCatalogService';
import type { DomainEvent } from '../../shared/events';
import type { CreateRoomOptionsV31 } from '../../shared/roomContract';

const options = (reviewEnabled: boolean): CreateRoomOptionsV31 => {
  const catalog = new RoomCatalogService().getCatalog();
  const preset = catalog.rolePresets.find((item) => item.enabled);
  assert.ok(preset);
  return {
    catalogVersion: catalog.catalogVersion,
    roomName: 'V3 log test',
    creator: { name: 'V3 observer', avatarId: 'avatar-test' },
    mode: 'quick_computer',
    visibility: 'invite_only',
    maxPlayers: 12,
    minHumanPlayers: 0,
    computerSeats: 0,
    aiFillPolicy: 'fill_to_max',
    roleSetup: { ...preset.roleSetup },
    rolePresetId: preset.id,
    rulesetId: preset.rulesetId,
    rulesetVersion: preset.rulesetVersion,
    readyPolicy: 'all_connected_humans',
    allowPublicSpectators: false,
    reviewEnabled,
  };
};

const application = () => createV3Application(
  resolveRuntimeConfig({
    WW_ENV: 'test',
    WW_DATA_DIR: '/tmp/werewolf-v3-log-test',
    WW_DEPLOYMENT_NAMESPACE: 'log-test',
  }),
  {
    autoDrive: true,
    roomOptions: {
      aiTimeoutMs: 100,
      session: { stageDurationMs: 500, rng: () => 0.25 },
    },
  },
);

const waitForEnd = async (app: ReturnType<typeof application>, code: string): Promise<NonNullable<Awaited<ReturnType<typeof app.rooms.getRecord>>>> => {
  const deadline = Date.now() + 20_000;
  let record = await app.rooms.getRecord(code);
  while (record?.status !== 'ended' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    record = await app.rooms.getRecord(code);
  }
  assert.ok(record);
  assert.equal(record.status, 'ended');
  return record;
};

test('V3 event stream records AI wolf discussion and kill decisions at commit time', async () => {
  const app = application();
  await app.start();
  try {
    const created = await app.rooms.create({
      actorId: 'observer',
      createRequestId: 'v3-log-events',
      options: options(false),
    });
    const record = await waitForEnd(app, created.room.code);
    const events = await app.eventStore.read(`game:${record.gameId}`);
    const types = new Set(events.map(({ event }) => event.eventType));
    assert.ok(types.has('wolf.message'));
    assert.ok(types.has('wolf.vote_cast'));
    assert.ok(types.has('wolf.kill_locked'));
    assert.ok(events.some(({ event }) => event.eventType === 'game.ended'));
  } finally {
    await app.close();
  }
});

test('test-drive uses the V3 composition root and keeps the review enabled', () => {
  const source = readFileSync(resolve(process.cwd(), 'test-drive.ts'), 'utf8');
  assert.match(source, /createV3Application/);
  assert.match(source, /reviewEnabled: true/);
  assert.doesNotMatch(source, /RoomEngine/);
});

test('review archive and QC source are the same completed V3 event stream', async () => {
  const gameId = 'v3-review-archive';
  const roomId = 'v3-review-room';
  const eventStore = new InMemoryEventStore();
  const event = (
    sequence: number,
    eventType: DomainEvent['eventType'],
    payload: Record<string, unknown>,
  ): DomainEvent => ({
    eventId: `${gameId}-${sequence}`,
    roomId,
    gameId,
    sequence,
    occurredAt: sequence,
    phase: sequence === 1 ? 'night' : 'ended',
    stage: sequence === 1 ? 'guard_seer' : null,
    eventType,
    payload,
    visibility: eventType === 'game.state_updated' ? 'spectator_omniscient' : 'public_timeline',
    correlationId: `review-${sequence}`,
    schemaVersion: 1,
  });
  await eventStore.append({
    streamId: `game:${gameId}`,
    expectedVersion: 0,
    events: [
      event(1, 'game.started', { day: 1 }),
      event(2, 'game.state_updated', {
        gameState: { day: 1 },
        players: [
          { id: 'wolf-1', name: '狼人一号', role: 'wolf', isAI: true, isAlive: true, order: 1 },
          { id: 'villager-1', name: '平民一号', role: 'villager', isAI: true, isAlive: true, order: 2 },
        ],
      }),
      event(3, 'game.ended', { winner: 'good', reason: 'test' }),
    ],
  });
  const app = createV3Application(
    resolveRuntimeConfig({
      WW_ENV: 'test',
      WW_DATA_DIR: '/tmp/werewolf-v3-log-test',
      WW_DEPLOYMENT_NAMESPACE: 'log-test',
    }),
    { autoDrive: false, eventStore },
  );
  await app.start();
  try {
    await app.reviewPipeline.enqueue({
      gameId,
      roomId,
      reviewEnabled: true,
    });
    await app.reviewPipeline.process(gameId);
    const review = await app.reviewPipeline.get(gameId);
    assert.ok(review);
    assert.equal(review.status, 'completed');
    const events = await app.eventStore.read(`game:${gameId}`);
    assert.deepEqual(
      review.archive.events.map(({ event }) => event.eventId),
      events.sort((left, right) => left.event.sequence - right.event.sequence).map(({ event }) => event.eventId),
    );
    assert.ok(review.messages.length > 0);
  } finally {
    await app.close();
  }
});
