import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { test as base } from 'playwright/test';
import { assertFixtureChecksum, computeFixtureChecksum } from '../support/fixtureChecksum';
import { assertNoArtifactCanary, assertPageHasNoArtifactCanary, newArtifactCanary } from '../support/artifactCanary';

export type TestFault = 'create_ack' | 'mutation_ack' | 'mutation_push' | 'provider' | 'write';

export interface V3Environment {
  readonly appURL: string;
  readonly serverURL: string;
  readonly controlURL: string;
  readonly dataDir: string;
  readonly namespace: string;
  readonly canary: string;
  stop(): Promise<void>;
  restart(): Promise<void>;
  advanceClock(milliseconds: number): Promise<void>;
  setFault(fault: TestFault, enabled?: boolean): Promise<void>;
  clearFaults(): Promise<void>;
}

type V3Fixtures = Record<never, never>;

type V3WorkerFixtures = {
  appURL: string;
  v3: V3Environment;
};

type ChildURLs = { child: ChildProcess; serverURL: string; controlURL: string };

const waitForURLs = (child: ChildProcess, label: string): Promise<{ serverURL: string; controlURL: string }> =>
  new Promise((resolve, reject) => {
    let output = '';
    let serverURL: string | undefined;
    let controlURL: string | undefined;
    const finish = (callback: () => void): void => {
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onError);
      child.off('exit', onExit);
      callback();
    };
    const check = (): void => {
      if (serverURL && controlURL) finish(() => resolve({ serverURL, controlURL }));
    };
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      serverURL ??= output.match(/\[e2e:v3\] listening (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      controlURL ??= output.match(/\[e2e:v3-control\] listening (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      check();
    };
    const onError = (chunk: Buffer): void => { output += chunk.toString(); };
    const onExit = (code: number | null): void => finish(() => reject(new Error(`${label} exited before startup (${code}): ${output}`)));
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onError);
    child.once('exit', onExit);
  });

const stopChild = async (child: ChildProcess | undefined): Promise<void> => {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once('exit', finish);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      finish();
    }, 2_000).unref();
  });
};

const waitForHealth = async (url: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {
      // The listening line can arrive just before the HTTP accept loop.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`V3 E2E server did not answer health checks at ${url}`);
};

const startPreview = async (): Promise<{ child: ChildProcess; url: string }> => {
  const child = spawn(process.execPath, [
    'node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '0',
  ], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    let settled = false;
    const cleanup = (): void => {
      child.stdout?.off('data', onChunk);
      child.stderr?.off('data', onChunk);
      child.off('exit', onExit);
    };
    const finishURL = (): void => {
      if (settled) return;
      const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
      const normalized = output.replace(ansiEscape, '');
      const match = normalized.match(/(https?:\/\/(?:127\.0\.0\.1|localhost):\d+)/);
      if (!match) return;
      settled = true;
      cleanup();
      resolve(match[1]);
    };
    const onChunk = (chunk: Buffer): void => {
      output += chunk.toString();
      finishURL();
    };
    const onExit = (code: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Vite preview exited before startup (${code}): ${output}`));
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.once('exit', onExit);
  });
  return { child, url };
};

const startV3Server = async (
  dataDir: string,
  namespace: string,
  canary: string,
  controlToken: string,
  secretKey: string,
  publicOrigin: string,
): Promise<ChildURLs> => {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'e2e/support/v3TestServer.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WW_ENV: 'test',
      WW_DATA_DIR: dataDir,
      WW_E2E_DATA_DIR: dataDir,
      WW_E2E_PORT: '0',
      WW_DEPLOYMENT_NAMESPACE: namespace,
      WW_TEST_CONTROL_TOKEN: controlToken,
      WW_TEST_ARTIFACT_CANARY: canary,
      WW_SECRET_KEY: secretKey,
      // Vite preview selects a worker port dynamically. Keep the E2E server's
      // exact CORS allowlist aligned with that origin instead of falling back
      // to the development default :3001.
      WW_PUBLIC_ORIGIN: publicOrigin,
      WW_CORS_ORIGINS: publicOrigin,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const urls = await waitForURLs(child, 'V3 E2E server');
  await waitForHealth(urls.serverURL);
  return { child, ...urls };
};

const controlRequest = async (
  environment: { controlURL: string; controlToken: string },
  endpoint: string,
  body?: unknown,
): Promise<Record<string, unknown>> => {
  const response = await fetch(`${environment.controlURL}${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-test-control-token': environment.controlToken,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok || result.ok !== true) throw new Error(`test control failed: ${endpoint}`);
  return result;
};

export const test = base.extend<V3Fixtures, V3WorkerFixtures>({
  appURL: [async ({ browserName: _browserName }, use) => {
    const preview = await startPreview();
    try {
      await use(preview.url);
    } finally {
      await stopChild(preview.child);
    }
  }, { scope: 'worker' }],

  v3: [async ({ appURL: _appURL }, use) => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ww-v3-playwright-'));
    const namespace = `e2e-${randomUUID()}`;
    const canary = newArtifactCanary(namespace);
    const controlToken = randomUUID();
    const secretKey = randomBytes(32).toString('base64');
    let server = await startV3Server(dataDir, namespace, canary, controlToken, secretKey, new URL(_appURL).origin);
    const initialChecksum = await computeFixtureChecksum(process.cwd());
    const environment: V3Environment = {
      appURL: _appURL,
      get serverURL() { return server.serverURL; },
      get controlURL() { return server.controlURL; },
      dataDir,
      namespace,
      canary,
      stop: async () => stopChild(server.child),
      restart: async () => {
        await stopChild(server.child);
        server = await startV3Server(dataDir, namespace, canary, controlToken, secretKey, new URL(_appURL).origin);
      },
      advanceClock: async (milliseconds) => {
        await controlRequest({ controlURL: server.controlURL, controlToken }, '/clock/advance', { ms: milliseconds });
      },
      setFault: async (fault, enabled = true) => {
        await controlRequest({ controlURL: server.controlURL, controlToken }, '/fault', { fault, enabled });
      },
      clearFaults: async () => {
        await controlRequest({ controlURL: server.controlURL, controlToken }, '/faults/clear', {});
      },
    };
    try {
      await use(environment);
    } finally {
      await stopChild(server.child);
      assertFixtureChecksum(initialChecksum, await computeFixtureChecksum(process.cwd()));
      await assertNoArtifactCanary([dataDir], canary);
      await rm(dataDir, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],
});

test.afterEach(async ({ page, v3 }, testInfo) => {
  await assertNoArtifactCanary([v3.dataDir, testInfo.outputDir], v3.canary);
  await assertPageHasNoArtifactCanary(page, v3.canary);
});

export { expect } from 'playwright/test';
