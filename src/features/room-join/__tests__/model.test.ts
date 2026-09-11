import assert from 'node:assert/strict';
import test from 'node:test';
import { joinActionLabel, joinIntentFromQuery, normalizeJoinCode } from '../model';

test('加入入口规范化房间码并保留深链意图', () => {
  assert.equal(normalizeJoinCode(' ab 12c '), 'AB12C');
  assert.equal(joinIntentFromQuery('watch'), 'watch');
  assert.equal(joinIntentFromQuery('unknown'), 'play');
  assert.equal(joinActionLabel('watch'), '进入观战');
  assert.equal(joinActionLabel('play'), '加入房间');
});
