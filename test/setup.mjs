import { webcrypto } from 'node:crypto';

// Node 18 does not expose WebCrypto as a global in every supported minor
// release. Keep the test environment identical to the browser contract.
if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== 'function') {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    enumerable: true,
    value: webcrypto,
    writable: false,
  });
}
