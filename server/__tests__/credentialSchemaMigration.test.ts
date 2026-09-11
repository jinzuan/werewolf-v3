import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CredentialSchemaAmbiguousError,
  canonicalCredentialValues,
  resolveBearerCredential,
} from '../security/roomCredentialStore';

test('credential migration emits one bearer value for one legacy value', () => {
  assert.equal(resolveBearerCredential({ apiKey: 'legacy' }), 'legacy');
  assert.deepEqual(canonicalCredentialValues({ token: 'legacy' }), { bearerCredential: 'legacy' });
  assert.equal(resolveBearerCredential({ apiKey: 'same', token: 'same' }), 'same');
});

test('different legacy key/token values fail closed', () => {
  assert.throws(
    () => resolveBearerCredential({ apiKey: 'key-a', token: 'token-b' }),
    (error: unknown) => error instanceof CredentialSchemaAmbiguousError && error.code === 'CREDENTIAL_SCHEMA_AMBIGUOUS',
  );
});
