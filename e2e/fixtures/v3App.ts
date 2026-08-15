import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test as base } from 'playwright/test';

export interface V3Environment {
  appURL: string;
  serverURL: string;
  dataDir: string;
}

type V3Fixtures = {
  appURL: string;
  v3: V3Environment;
};

const waitForURL = (
  child: ChildProcess,
  pattern: RegExp,
  label: string,
): Promise<string> => new Promise((resolve, reject) => {
  let output = '';
  let settled = false;
  const finish = (callback: () => void): void => {
    if (settled) return;
    settled = true;
    child.stdout?.off('data', onData);
    child.stderr?.off('data', onError);
    child.off('exit', onExit);
    callback();
  };
  const onData = (chunk: Buffer): void => {
    output += chunk.toString();
    const match = output.match(pattern);
    if (match) finish(() => resolve(match[1]));
  };
  const onError = (chunk: Buffer): void => { output += chunk.toString(); };
  const onExit = (code: number | null): void => finish(() => reject(new Error(
    `${label} exited before startup (${code}): ${output}`,
  )));
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

const startPreview = async (): Promise<{ child: ChildProcess; url: string }> => {
  const child = spawn(process.execPath, [
    'node_modules/vite/bin/vite.js',
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await waitForURL(child, /(http:\/\/127\.0\.0\.1:\d+)/, 'Vite preview');
  return { child, url };
};

const startV3Server = async (dataDir: string): Promise<{ child: ChildProcess; url: string }> => {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'e2e/support/v3TestServer.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WW_ENV: 'test',
      WW_E2E_DATA_DIR: dataDir,
      WW_E2E_PORT: '0',
      WW_DEPLOYMENT_NAMESPACE: `e2e-${randomUUID()}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await waitForURL(child, /(http:\/\/127\.0\.0\.1:\d+)/, 'V3 E2E server');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${url}/health`)).ok) return { child, url };
    } catch {
      // The listening line can arrive just before the HTTP accept loop.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await stopChild(child);
  throw new Error(`V3 E2E server did not answer health checks at ${url}`);
};

export const test = base.extend<V3Fixtures>({
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
    const server = await startV3Server(dataDir);
    try {
      await use({ appURL: _appURL, serverURL: server.url, dataDir });
    } finally {
      await stopChild(server.child);
      await rm(dataDir, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],
});

export { expect } from 'playwright/test';
