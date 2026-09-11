import assert from 'node:assert/strict';
import test from 'node:test';
import { EndpointPolicy, EndpointPolicyError } from '../security/endpointPolicy';
import { SafeHttpClient } from '../security/safeHttpClient';

test('safe client passes a fixed validated address set to its transport', async () => {
  let received: string[] = [];
  const policy = new EndpointPolicy({
    environment: 'production',
    allowlist: 'provider.test',
    lookup: async () => [
      { address: '203.0.113.10', family: 4 },
      { address: '2001:4860:4860::10', family: 6 },
    ],
  });
  const client = new SafeHttpClient(policy, {
    transport: async ({ endpoint, options }) => {
      received = endpoint.addresses.map((entry) => entry.address);
      assert.equal(new Headers(options.headers).get('authorization'), 'Bearer canary');
      return new Response('{}', { status: 200 });
    },
  });
  const response = await client.request('https://provider.test/v1/chat', {
    method: 'POST',
    headers: { Authorization: 'Bearer canary' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(received, ['203.0.113.10', '2001:4860:4860::10']);
});

test('endpoint policy rejects a mixed public/private DNS answer before transport', async () => {
  const policy = new EndpointPolicy({
    environment: 'production',
    allowlist: 'provider.test',
    lookup: async () => [
      { address: '203.0.113.10', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ],
  });
  await assert.rejects(
    () => policy.validate('https://provider.test/v1/chat'),
    (error: unknown) => error instanceof EndpointPolicyError && error.code === 'ENDPOINT_PRIVATE_ADDRESS',
  );
});
