import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService, RoomServiceError } from '../rooms/roomService';
import type { RoomMutationCommand } from '../../shared/protocol';

const createRoom = async (rooms: RoomService) => {
  const catalog = rooms.getCatalog();
  const preset = catalog.rolePresets.find((item) => item.enabled)!;
  return rooms.create({
    actorId: 'host',
    createRequestId: 'receipt-create',
    options: {
      catalogVersion: catalog.catalogVersion,
      roomName: 'receipt room',
      creator: { name: 'Host', avatarId: 'avatar-player' },
      mode: 'human',
      visibility: 'invite_only',
      maxPlayers: preset.playerCount,
      minHumanPlayers: preset.playerCount,
      computerSeats: 0,
      aiFillPolicy: 'none',
      roleSetup: { ...preset.roleSetup },
      rolePresetId: preset.id,
      rulesetId: preset.rulesetId,
      rulesetVersion: preset.rulesetVersion,
      readyPolicy: 'all_connected_humans',
      allowPublicSpectators: false,
      reviewEnabled: false,
    },
  });
};

test('room mutation commits a durable receipt and replays by commandId', async () => {
  const rooms = new RoomService(new InMemoryRoomRepository(), new InMemoryEventStore(), { autoDrive: false });
  try {
    const access = await createRoom(rooms);
    const identity = await rooms.identity(
      access.room.code,
      'host',
      access.credentials.resumeToken,
    );
    const command: RoomMutationCommand = { type: 'room.dissolve', payload: { confirm: true } };
    const first = await rooms.runRoomMutation(identity, 'ready-command', access.room.roomRevision, command);
    assert.equal(first.receipt.status, 'committed');
    assert.equal(first.receipt.commandId, 'ready-command');
    assert.equal((await rooms.commandReceipt(identity, 'ready-command'))?.commandId, 'ready-command');

    const replay = await rooms.runRoomMutation(identity, 'ready-command', 1, command);
    assert.deepEqual(replay.receipt, first.receipt);
  } finally {
    await rooms.close();
  }
});

test('rejected room mutations retain a safe durable receipt', async () => {
  const rooms = new RoomService(new InMemoryRoomRepository(), new InMemoryEventStore(), { autoDrive: false });
  try {
    const access = await createRoom(rooms);
    const identity = await rooms.identity(
      access.room.code,
      'host',
      access.credentials.resumeToken,
    );
    await assert.rejects(
      rooms.runRoomMutation(
        identity,
        'cancel-dissolve-command',
        access.room.roomRevision,
        { type: 'room.dissolve', payload: { confirm: false } },
      ),
      (error: unknown) =>
        error instanceof RoomServiceError &&
        error.code === 'ACTION_NOT_ALLOWED' &&
        error.receipt?.status === 'rejected',
    );
    const receipt = await rooms.commandReceipt(identity, 'cancel-dissolve-command');
    assert.equal(receipt?.status, 'rejected');
    assert.equal(receipt?.errorCode, 'ACTION_NOT_ALLOWED');
  } finally {
    await rooms.close();
  }
});
