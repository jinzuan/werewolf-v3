import path from 'node:path';
import { createV3Application } from '../../server/app/createV3Application';

const dataDir = process.env.WW_E2E_DATA_DIR;
if (!dataDir || !path.isAbsolute(dataDir)) {
  throw new Error('WW_E2E_DATA_DIR must point at an explicit temporary directory.');
}

const application = await createV3Application({
  enableTestControl: true,
  // E2E uses real wall-clock deadlines; the test-control clock is only for
  // explicit control-port probes and must not freeze automatic AI stages.
  clock: Date.now,
  roomOptions: {
    aiTimeoutMs: 500,
    aiSpeechDelayMinMs: 0,
    aiSpeechDelayMaxMs: 0,
    session: { stageDurationMs: 1_000 },
  },
  runtime: undefined,
  socket: {
    dropCreateAckOnce: process.env.WW_TEST_DROP_CREATE_ACK_ONCE === '1',
  },
});
const serverURL = await application.start(Number(process.env.WW_E2E_PORT ?? 0), '127.0.0.1');
console.log(`[e2e:v3] listening ${serverURL}`);
if (!application.testControl) throw new Error('E2E application did not expose its test control port');
console.log(`[e2e:v3-control] listening ${application.testControl.url}`);

const shutdown = async (): Promise<void> => {
  await application.close();
};
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
