import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { resolveRuntimeConfig } from '../runtimeConfig';

test('development defaults to a namespace-scoped data root', () => {
  const config = resolveRuntimeConfig(
    { WW_ENV: 'development', WW_DEPLOYMENT_NAMESPACE: 'laptop' },
    '/workspace/project',
  );
  const expectedRoot = path.resolve('/workspace/project', '.data', 'dev', 'laptop');
  assert.equal(config.dataDir, expectedRoot);
  assert.equal(config.roomsFile, path.join(expectedRoot, 'rooms.json'));
  assert.equal(config.secretsDir, path.join(expectedRoot, 'secrets'));
});
test('production and test require explicit isolated roots', () => {
  assert.throws(
    () => resolveRuntimeConfig({ WW_ENV: 'production', WW_DEPLOYMENT_NAMESPACE: 'prod' }),
    /explicit WW_DATA_DIR/,
  );
  assert.throws(
    () => resolveRuntimeConfig({ WW_ENV: 'test' }),
    /explicit temporary WW_DATA_DIR/,
  );
  assert.throws(
    () => resolveRuntimeConfig({ WW_ENV: 'test', WW_DATA_DIR: 'tmp/test-data' }),
    /absolute directory/,
  );
});

test('production requires an explicit namespace and parses TTLs', () => {
  assert.throws(
    () => resolveRuntimeConfig({ WW_ENV: 'production', WW_DATA_DIR: '/var/lib/werewolf' }),
    /explicit WW_DEPLOYMENT_NAMESPACE/,
  );
  const config = resolveRuntimeConfig({
    WW_ENV: 'test',
    WW_DATA_DIR: '/tmp/ww-e2e-123',
    WW_DEPLOYMENT_NAMESPACE: 'e2e',
    WW_WAITING_ROOM_TTL_MS: '10',
    WW_ENDED_ROOM_TTL_MS: '20',
    WW_ROOM_SWEEP_INTERVAL_MS: '30',
  });
  assert.deepEqual(
    [config.waitingRoomTtlMs, config.endedRoomTtlMs, config.roomSweepIntervalMs],
    [10, 20, 30],
  );
});
