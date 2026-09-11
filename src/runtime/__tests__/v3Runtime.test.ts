import assert from 'node:assert/strict';
import test from 'node:test';
import { V3Runtime } from '../v3Runtime';

test('V3Runtime start and dispose are idempotent and release subscriptions', () => {
  let starts = 0;
  let cleanups = 0;
  let disposes = 0;
  const runtime = new V3Runtime({
    start: () => {
      starts += 1;
      return () => { cleanups += 1; };
    },
    dispose: () => { disposes += 1; },
  });

  runtime.start();
  runtime.start();
  runtime.dispose();
  runtime.dispose();
  runtime.start();
  runtime.dispose();

  assert.equal(starts, 2);
  assert.equal(cleanups, 2);
  assert.equal(disposes, 2);
});
