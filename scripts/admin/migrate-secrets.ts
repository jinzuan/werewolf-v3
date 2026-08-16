import path from 'node:path';
import { EndpointPolicy } from '../../server/security/endpointPolicy';
import {
  EncryptedFileCredentialStore,
  InMemoryCredentialStore,
} from '../../server/security';
import {
  migrateLegacySecrets,
  scanLegacySecretBackups,
} from '../../server/security/secretMigration';

type Command = 'migrate' | 'scan';

const args = process.argv.slice(2);
const command = (args[0] ?? 'migrate') as Command;
const valueFor = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const fail = (message: string): never => {
  throw new Error(`[migrate-secrets] ${message}`);
};
const absolute = (value: string | undefined, label: string): string => {
  if (!value || !path.isAbsolute(value) || path.parse(value).root === value) {
    fail(`${label} must be an explicit absolute, non-root path.`);
  }
  return path.resolve(value);
};

if (command !== 'migrate' && command !== 'scan') {
  fail('usage: migrate|scan --data-dir ABSOLUTE --namespace NAME [--input ABSOLUTE]');
}
const dataRoot = absolute(valueFor('--data-dir'), '--data-dir');
const namespace = valueFor('--namespace');
if (!namespace || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(namespace)) {
  fail('--namespace is required and must be a safe deployment namespace.');
}
const secretRoot = absolute(valueFor('--secret-root') ?? path.join(dataRoot, 'secrets'), '--secret-root');
const inputPath = valueFor('--input');
if (command === 'migrate' && !inputPath) fail('migrate requires --input ABSOLUTE.');
if (inputPath && !path.isAbsolute(inputPath)) fail('--input must be absolute.');

const environment = process.env.WW_ENV ?? 'development';
const secretKey = process.env.WW_SECRET_KEY;
if (environment === 'production' && !secretKey) fail('production secret migration requires WW_SECRET_KEY.');
const credentialStore = secretKey
  ? new EncryptedFileCredentialStore(
      process.env.WW_SECRET_FILE ?? path.join(secretRoot, 'credentials.json'),
      { masterKey: secretKey, keyId: process.env.WW_SECRET_KEY_ID, environment: environment as 'production' | 'development' | 'test', dataRoot },
    )
  : new InMemoryCredentialStore();
const endpointPolicy = new EndpointPolicy({
  environment: environment as 'production' | 'development' | 'test',
  resolveDns: false,
});
const auditPath = path.join(secretRoot, 'legacy-secret-migration-audit.json');

if (command === 'scan') {
  console.log(JSON.stringify(await scanLegacySecretBackups({
    dataRoot,
    secretRoot,
    namespace,
    store: credentialStore,
    endpointPolicy,
    inputPath,
    auditPath,
  })));
} else {
  const recoveryName = valueFor('--recovery-name');
  const result = await migrateLegacySecrets({
    inputPath: path.resolve(inputPath!),
    dataRoot,
    namespace,
    store: credentialStore,
    endpointPolicy,
    auditPath,
    ...(recoveryName
      ? {
          recovery: {
            secretRoot,
            masterKey: secretKey ?? fail('--recovery-name requires WW_SECRET_KEY.'),
            fileName: recoveryName,
            keyId: process.env.WW_SECRET_KEY_ID,
          },
        }
      : {}),
  });
  console.log(JSON.stringify(result));
}
