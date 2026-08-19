import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveRequestProtocol, parseRuntimeSecurityConfig } from '../security/runtimeSecurityConfig';
import { redactJson } from '../../shared/redact';

test('production security config requires HTTPS and exact CORS origins', () => {
  const config = parseRuntimeSecurityConfig({
    WW_ENV: 'production',
    WW_PUBLIC_ORIGIN: 'https://play.example.com',
    WW_CORS_ORIGINS: 'https://play.example.com,https://admin.example.com',
    WW_SECRET_STORE: 'encrypted_file',
    WW_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
  });
  assert.deepEqual(config.corsOrigins, ['https://play.example.com', 'https://admin.example.com']);
  assert.equal(effectiveRequestProtocol({ 'x-forwarded-proto': 'https' }, true), 'https');
  assert.equal(effectiveRequestProtocol({ 'x-forwarded-proto': 'https' }, false), 'http');
  assert.throws(() => parseRuntimeSecurityConfig({
    WW_ENV: 'production', WW_PUBLIC_ORIGIN: 'http://play.example.com', WW_SECRET_KEY: 'x',
  }));
});

test('development and test listeners cannot be widened to a public host', () => {
  assert.throws(() => parseRuntimeSecurityConfig({
    WW_ENV: 'development',
    WW_BIND_HOST: '0.0.0.0',
    WW_PUBLIC_ORIGIN: 'http://198.51.100.10:3001',
  }), /bind host must be loopback/);
});

test('recursive redaction covers credential aliases and does not expose canaries', () => {
  const value = redactJson({ aiConfig: { apiKey: 'canary-api-key', token: 'canary-token' }, nested: { authorization: 'Bearer canary-auth' } });
  assert.doesNotMatch(JSON.stringify(value), /canary-api-key|canary-token|canary-auth/);
});
