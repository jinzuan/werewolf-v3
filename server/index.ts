import { createV3Application } from './app/createV3Application';

const application = await createV3Application();
const url = await application.start();
const security = application.security;
console.log(
  `[server:v3] listening on ${security.environment === 'production' ? 'https' : 'http'}://${application.runtime.bindHost}:${new URL(url).port} ` +
    `env=${application.runtime.environment} namespace=${application.runtime.deploymentNamespace}`,
);
if (security.environment !== 'production') {
  console.warn('[server:security] development/test HTTP exception is limited to loopback');
}

const shutdown = async (): Promise<void> => {
  await application.close();
};
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
