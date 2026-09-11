import assert from 'node:assert/strict';
import test from 'node:test';
import { createV3Application } from '../app/createV3Application';
import { InMemoryEventStore } from '../events/store';
import { resolveRuntimeConfig } from '../runtimeConfig';
import { InMemoryRoomRepository } from '../rooms/repository';

test('createV3Application is the single start/close lifecycle and close is idempotent', async () => {
  const eventStore = new InMemoryEventStore();
  const roomRepository = new InMemoryRoomRepository();
  const app = createV3Application(
    resolveRuntimeConfig({
      WW_ENV: 'test',
      WW_DATA_DIR: '/tmp/werewolf-v3-composition-root',
      WW_DEPLOYMENT_NAMESPACE: 'composition-test',
    }),
    { eventStore, roomRepository, autoDrive: false },
  );
  assert.strictEqual(app.eventStore, eventStore);
  await app.start();
  assert.equal(await app.start(), 0);
  await app.close();
  await app.close();
  await assert.rejects(() => app.start(), /V3_APPLICATION_CLOSED/);
});
