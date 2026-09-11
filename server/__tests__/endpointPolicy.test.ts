import assert from 'node:assert/strict';
import test from 'node:test';
import { EndpointPolicy, EndpointPolicyError, isForbiddenAddress } from '../security/endpointPolicy';

test('endpoint policy rejects local, metadata, and mapped IPv6 addresses', () => {
  for (const address of ['127.0.0.1', '::1', '10.0.0.1', '192.168.1.20', '169.254.169.254', '::ffff:127.0.0.1']) {
    assert.equal(isForbiddenAddress(address), true, address);
  }
});

test('development explicitly permits only loopback HTTP', async () => {
  const policy = new EndpointPolicy({ environment: 'development', resolveDns: false });
  await assert.doesNotReject(() => policy.validate('http://127.0.0.1:1234/v1', { provider: 'local' }));
  await assert.rejects(
    () => policy.validate('http://example.com:1234/v1', { provider: 'custom' }),
    (error: unknown) => error instanceof EndpointPolicyError && error.code === 'ENDPOINT_SCHEME_NOT_ALLOWED',
  );
});

test('DNS rebinding and mixed DNS answers fail closed before a request', async () => {
  const policy = new EndpointPolicy({
    environment: 'production',
    allowlist: 'provider.example',
    lookup: async () => [
      { address: '203.0.113.10', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ],
  });
  await assert.rejects(
    () => policy.validate('https://provider.example/v1', { provider: 'custom' }),
    (error: unknown) => error instanceof EndpointPolicyError && error.code === 'ENDPOINT_PRIVATE_ADDRESS',
  );
});

test('userinfo, query, fragment, and non-standard ports are rejected', async () => {
  const policy = new EndpointPolicy({ environment: 'production', allowlist: 'provider.example' });
  for (const endpoint of [
    'https://user:pass@provider.example/v1',
    'https://provider.example/v1?token=secret',
    'https://provider.example/v1#fragment',
    'https://provider.example:8443/v1',
  ]) {
    await assert.rejects(() => policy.validate(endpoint, { provider: 'custom', allowReservedTestHost: true }));
  }
});
