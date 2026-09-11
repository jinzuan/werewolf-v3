import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandOutcomeRegistry } from '../commandOutcome';

test('command outcome keeps unknown distinct from not_sent and commits on evidence', () => {
  const registry = new CommandOutcomeRegistry();
  registry.begin('sent', 'room.ready');
  assert.equal(registry.markUnknown('sent').status, 'unknown');
  assert.equal(registry.markCommitted('sent').status, 'committed');
  // A late transport failure cannot roll a committed command back.
  assert.equal(registry.markUnknown('sent').status, 'committed');

  registry.begin('unsent', 'room.ready');
  assert.equal(registry.markNotSent('unsent').status, 'not_sent');
  assert.equal(registry.get('sent')?.status, 'committed');
});
