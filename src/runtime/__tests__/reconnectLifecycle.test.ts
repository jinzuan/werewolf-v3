import assert from 'node:assert/strict';
import test from 'node:test';
import { subscribeV3ReconnectLifecycle } from '../reconnectLifecycle';

class VisibilityTarget extends EventTarget {
  visibilityState = 'hidden';

  emit(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}

test('reconnect lifecycle recovers across browser and app-switch lifecycle signals', () => {
  const documentTarget = new VisibilityTarget();
  const windowTarget = new EventTarget();
  let recoveries = 0;
  const cleanup = subscribeV3ReconnectLifecycle(
    () => { recoveries += 1; },
    { documentTarget, windowTarget },
  );

  documentTarget.emit('visibilitychange');
  assert.equal(recoveries, 0);
  documentTarget.visibilityState = 'visible';
  documentTarget.emit('visibilitychange');
  windowTarget.dispatchEvent(new Event('pageshow'));
  windowTarget.dispatchEvent(new Event('online'));
  windowTarget.dispatchEvent(new Event('focus'));
  windowTarget.dispatchEvent(new Event('resume'));
  assert.equal(recoveries, 5);

  cleanup();
  documentTarget.emit('visibilitychange');
  windowTarget.dispatchEvent(new Event('pageshow'));
  windowTarget.dispatchEvent(new Event('online'));
  windowTarget.dispatchEvent(new Event('focus'));
  windowTarget.dispatchEvent(new Event('resume'));
  assert.equal(recoveries, 5);
});
