import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRoomRepository } from '../rooms/repository';
import { InMemoryLifecycleOutbox } from '../rooms/lifecycleOutbox';
import { RoomLifecycleService } from '../rooms/roomLifecycleService';
import { InMemoryCredentialStore } from '../security/roomCredentialStore';
import type { RoomRecord } from '../rooms/types';

const room = (): RoomRecord => ({
  id: 'room-id', code: 'SAGA01', name: 'saga', joinToken: 'join', omniscientToken: 'omni',
  hostId: 'host', maxPlayers: 1, status: 'waiting', auto: false, debugMode: false,
  members: [], players: [], environment: 'test', deploymentNamespace: 'saga-test',
  config: { mode: 'human', visibility: 'invite_only', maxPlayers: 1, minHumanPlayers: 1,
    aiFillPolicy: 'none', computerSeats: 0, roleSetup: { wolf: 0, seer: 0, witch: 0, hunter: 0, guardian: 0, villager: 1 },
    rulesetId: 'rules', rulesetVersion: '1', catalogVersion: '1', readyPolicy: 'all_connected_humans',
    allowPublicSpectators: false, credentialRef: 'credential-ref' },
  createdAt: 1, lastActivityAt: 1,
});

test('cleanup failure leaves tombstone and outbox intent for retry', async () => {
  const repository = new InMemoryRoomRepository([room()]);
  const outbox = new InMemoryLifecycleOutbox();
  const credentials = new InMemoryCredentialStore();
  await credentials.put({ namespace: 'saga-test', roomCode: 'SAGA01' }, { bearerCredential: 'secret' });
  const originalDelete = credentials.delete.bind(credentials);
  let fail = true;
  credentials.delete = async (...args) => {
    if (fail) throw Object.assign(new Error('temporary'), { code: 'TEMPORARY_FAILURE' });
    return originalDelete(...args);
  };
  let now = 1;
  const lifecycle = new RoomLifecycleService(repository, {
    environment: 'test', deploymentNamespace: 'saga-test', credentialNamespace: 'saga-test',
    credentialStore: credentials, outbox, clock: () => now, retryBaseMs: 1,
  });
  const first = await lifecycle.commit('SAGA01', 'dissolve');
  assert.equal(first.cleanupPending, true);
  assert.equal((await repository.get('SAGA01'))?.lifecycleTombstone?.kind, 'dissolve');
  assert.equal((await outbox.list()).length, 1);

  fail = false;
  now = 10;
  assert.equal(await lifecycle.retryPending(), 1);
  assert.equal(await repository.get('SAGA01'), undefined);
  assert.equal((await outbox.list()).length, 0);
});
