import assert from 'node:assert/strict';
import test from 'node:test';
import { JoinRateLimiter, InMemoryRateLimitStore } from '../security/joinRateLimiter';
import { effectiveClientAddress, TrustedProxyPolicy } from '../security/trustedProxyPolicy';
import { parseRuntimeSecurityConfig } from '../security/runtimeSecurityConfig';
import { resolveRuntimeConfig } from '../runtimeConfig';

test('IP and room buckets cannot be bypassed by rotating actor ids', async () => {
  let now = 1_000;
  const limiter = new JoinRateLimiter({
    store: new InMemoryRateLimitStore(),
    capacity: 2,
    refillPerSecond: 1,
    now: () => now,
  });
  assert.equal((await limiter.check({ clientIp: '192.0.2.10', roomCode: 'abc', actorId: 'a' })).allowed, true);
  assert.equal((await limiter.check({ clientIp: '192.0.2.10', roomCode: 'abc', actorId: 'b' })).allowed, true);
  const blocked = await limiter.check({ clientIp: '192.0.2.10', roomCode: 'abc', actorId: 'rotated-c' });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  now += 1_000;
  assert.equal((await limiter.check({ clientIp: '192.0.2.10', roomCode: 'ABC', actorId: 'd' })).allowed, true);
});

test('pre-auth client address uses the trusted proxy result and ignores direct spoofing', () => {
  const config = parseRuntimeSecurityConfig({
    WW_ENV: 'production',
    WW_PUBLIC_ORIGIN: 'https://play.example.com',
    WW_SECRET_STORE: 'encrypted_file',
    WW_SECRET_KEY: Buffer.alloc(32, 6).toString('base64'),
    WW_TRUST_PROXY: 'true',
    WW_TRUST_PROXY_CIDRS: '10.0.0.0/8',
    WW_BIND_HOST: '0.0.0.0',
  });
  const policy = new TrustedProxyPolicy(config.trustProxy);
  assert.equal(effectiveClientAddress({
    socket: { remoteAddress: '10.0.0.7' },
    headers: { 'x-forwarded-for': '2001:db8::7, 10.0.0.7' },
  }, policy), '2001:db8::7');
  assert.equal(effectiveClientAddress({
    socket: { remoteAddress: '192.0.2.7' },
    headers: { 'x-forwarded-for': '2001:db8::7' },
  }, policy), '192.0.2.7');
});

test('multiple runtime instances require an explicitly shared rate-limit store', () => {
  assert.throws(
    () => resolveRuntimeConfig({
      WW_ENV: 'test',
      WW_DATA_DIR: '/tmp/ww-rate-limit-test',
      WW_DEPLOYMENT_NAMESPACE: 'test',
      WW_INSTANCE_COUNT: '2',
    }),
    /shared RateLimitStore/,
  );
});
