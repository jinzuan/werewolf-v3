import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseRuntimeSecurityConfig,
  RuntimeSecurityConfigError,
  isSecureRequest,
} from '../security/runtimeSecurityConfig';
import {
  parseTrustedProxySource,
  TrustedProxyPolicy,
} from '../security/trustedProxyPolicy';

const productionEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  WW_ENV: 'production',
  WW_PUBLIC_ORIGIN: 'https://play.example.com',
  WW_SECRET_STORE: 'encrypted_file',
  WW_SECRET_KEY: Buffer.alloc(32, 8).toString('base64'),
  ...extra,
});

test('trust proxy requires an explicit source list and bind host', () => {
  assert.throws(
    () => parseRuntimeSecurityConfig(productionEnv({ WW_TRUST_PROXY: 'true' })),
    (error: unknown) => error instanceof RuntimeSecurityConfigError,
  );
  assert.throws(
    () => parseRuntimeSecurityConfig(productionEnv({
      WW_TRUST_PROXY: 'true',
      WW_TRUST_PROXY_CIDRS: '10.0.0.0/not-a-prefix',
      WW_BIND_HOST: '0.0.0.0',
    })),
    (error: unknown) => error instanceof RuntimeSecurityConfigError,
  );

  const config = parseRuntimeSecurityConfig(productionEnv({
    WW_TRUST_PROXY: 'true',
    WW_TRUST_PROXY_CIDRS: '10.0.0.0/8,2001:db8::/32',
    WW_BIND_HOST: '0.0.0.0',
  }));
  assert.equal(config.trustProxy.enabled, true);
  assert.equal(config.trustProxy.sources.length, 2);
  assert.equal(config.bindHost, '0.0.0.0');
});

test('forwarded protocol is accepted only from a matching proxy peer', () => {
  const config = parseRuntimeSecurityConfig(productionEnv({
    WW_TRUST_PROXY: 'true',
    WW_TRUST_PROXY_CIDRS: '10.0.0.0/8,2001:db8::/32',
    WW_BIND_HOST: '0.0.0.0',
  }));
  const httpsFromProxy = {
    headers: { 'x-forwarded-proto': 'https' },
    socket: { remoteAddress: '10.42.0.7' },
  };
  assert.equal(isSecureRequest(httpsFromProxy, config), true);
  assert.equal(isSecureRequest({
    ...httpsFromProxy,
    socket: { remoteAddress: '192.0.2.7' },
  }, config), false);
  assert.equal(isSecureRequest({
    ...httpsFromProxy,
    headers: { 'x-forwarded-proto': 'https, http' },
  }, config), false);
  assert.equal(isSecureRequest({
    ...httpsFromProxy,
    headers: { 'x-forwarded-proto': 'ftp' },
  }, config), false);
  assert.equal(isSecureRequest({
    headers: { 'x-forwarded-proto': 'https' },
    socket: { remoteAddress: '::ffff:10.42.0.7' },
  }, config), true);
  assert.equal(isSecureRequest({
    headers: { 'x-forwarded-proto': 'https' },
    socket: { remoteAddress: '2001:db8::7' },
  }, config), true);
});

test('trusted proxy source parser rejects malformed CIDR and normalizes mapped IPv4', () => {
  assert.deepEqual(parseTrustedProxySource('::ffff:10.0.0.1'), {
    address: '10.0.0.1', family: 4, prefixLength: 32,
  });
  assert.throws(() => parseTrustedProxySource('10.0.0.1/33'));
  assert.throws(() => parseTrustedProxySource('not-an-ip'));
  const policy = new TrustedProxyPolicy({
    enabled: true,
    sources: [parseTrustedProxySource('10.0.0.0/8')],
    bindHost: '127.0.0.1',
  });
  assert.equal(policy.isTrusted('::ffff:10.1.2.3'), true);
});
