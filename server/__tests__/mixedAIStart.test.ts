import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';
import { createRequest, dispatch, startRoom } from './fixtures';

test('mixed games keep the human viewer in the player seat while AI roles auto-confirm', async () => {
  const rooms = new RoomService(
    new InMemoryRoomRepository(),
    new InMemoryEventStore(),
    // The regression must not depend on the background AI driver just to
    // clear the initial role-confirmation barrier.
    { autoDrive: false },
  );
  try {
    const created = await rooms.create({
      ...createRequest(rooms, 'host', 'mixed-ai-start', '混合 AI 开局', {
        minHumanPlayers: 1,
        computerSeats: 11,
        aiFillPolicy: 'fixed',
      }),
    });
    const host = await rooms.identity(
      created.room.code,
      'host',
      created.credentials.resumeToken,
    );

    await startRoom(rooms, host, 'mixed-ai');

    const startedRoom = await rooms.get(created.room.code, 'host');
    assert.equal(startedRoom.status, 'playing');
    assert.equal(startedRoom.viewer.kind, 'player');
    assert.equal(
      startedRoom.members.find((member) => member.id === 'host')?.kind,
      'player',
    );
    assert.equal(startedRoom.members.filter((member) => member.isAI).length, 11);

    const session = rooms.session(created.room.code);
    assert.ok(session);
    const state = session.serialize().state;
    assert.equal(state.gameState.phase, 'role_confirm');
    assert.equal(state.roleConfirmations.host, false);
    assert.equal(
      state.players
        .filter((player) => player.isAI)
        .every((player) => state.roleConfirmations[player.id] === true),
      true,
    );

    const snapshot = await rooms.snapshot(host);
    assert.equal(snapshot.viewer.kind, 'player');
    assert.equal(snapshot.viewer.playerId, 'host');
    assert.deepEqual(snapshot.gameState.allowedActors, [
      { playerId: 'host', actions: ['confirm_role'] },
    ]);

    await dispatch(session, 'host', {
      type: 'game.confirm_role',
      payload: {},
    });
    assert.equal(session.serialize().state.gameState.phase, 'night');
  } finally {
    await rooms.close();
  }
});
