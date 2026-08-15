import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRoomScene, sceneForRoom } from '../scene';

test('场景只消费房间与权威阶段，不使用客户端时间', () => {
  assert.equal(resolveRoomScene({ roomStatus: 'waiting', phase: 'waiting' }), 'lobby');
  assert.equal(resolveRoomScene({ roomStatus: 'ready_check', phase: 'waiting' }), 'dusk');
  assert.equal(resolveRoomScene({ roomStatus: 'starting' }), 'dusk');
  assert.equal(resolveRoomScene({ roomStatus: 'playing', phase: 'night', stage: 'wolf_vote' }), 'night');
  assert.equal(resolveRoomScene({ roomStatus: 'playing', phase: 'day', stage: 'dawn' }), 'dawn');
  assert.equal(resolveRoomScene({ roomStatus: 'playing', phase: 'voting' }), 'day');
  assert.equal(sceneForRoom('ended', { phase: 'ended', nightStage: null }), 'ended');
});
