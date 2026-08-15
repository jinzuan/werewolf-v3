import type { Server, Socket } from 'socket.io';
import type {
  GameCommand,
  ProtocolAckError,
  ProtocolErrorCode,
  RoomSnapshotReason,
  RoomView,
  V3Command,
} from '../../shared/protocol';
import type { RoomAccess, SocketIdentity } from '../rooms/types';
import { RoomService, RoomServiceError } from '../rooms/roomService';

interface SocketState {
  identity?: SocketIdentity;
  lastSequence?: number;
}

const state = (socket: Socket): SocketState => socket.data as SocketState;

const isGameCommand = (
  command: V3Command['command'],
): command is GameCommand => command.type.startsWith('game.');

const STABLE_CODES = new Set<ProtocolErrorCode>([
  'UNAUTHENTICATED',
  'IDENTITY_MISMATCH',
  'ROOM_MISMATCH',
  'GAME_MISMATCH',
  'SPECTATOR_READ_ONLY',
  'DUPLICATE_COMMAND',
  'STALE_STAGE_REVISION',
  'EXPIRED_COMMAND',
  'ACTION_NOT_ALLOWED',
  'INVALID_TARGET',
  'ACTOR_NOT_FOUND',
  'ACTOR_DEAD',
  'INVALID_COMMAND',
  'INVALID_GAME_META',
  'IDENTITY_ALREADY_BOUND',
  'IDENTITY_ALREADY_EXISTS',
  'ROOM_TOKEN_INVALID',
  'ROOM_FULL',
  'ROOM_NOT_FOUND',
  'HOST_REQUIRED',
  'GAME_ALREADY_STARTED',
  'GAME_NOT_STARTED',
  'MEMBER_NOT_FOUND',
  'ROLE_NOT_ASSIGNED',
  'COMMAND_NOT_IMPLEMENTED',
  'PUSH_FAILED',
  'ROOM_REVISION_CONFLICT',
  'INVALID_ROOM_CONFIG',
  'ROLE_COUNT_MISMATCH',
  'RULESET_UNAVAILABLE',
  'MIN_PLAYERS_NOT_MET',
  'HUMAN_PLAYERS_NOT_READY',
  'MEMBER_OFFLINE',
  'CONFIG_LOCKED',
  'GAME_START_IN_PROGRESS',
  'GAME_START_FAILED',
  'INVALID_ROLE_SETUP',
  'UNKNOWN_ERROR',
]);

const errorResponse = (error: unknown): ProtocolAckError => {
  if (error instanceof RoomServiceError) {
    return {
      ok: false,
      code: error.code,
      messageKey: error.messageKey,
      ...(error.params ? { params: error.params } : {}),
      ...(error.issues ? { issues: error.issues } : {}),
    };
  }
  const candidate = error as {
    code?: unknown;
    messageKey?: unknown;
    params?: unknown;
    issues?: unknown;
  };
  const code =
    typeof candidate?.code === 'string' && STABLE_CODES.has(candidate.code as ProtocolErrorCode)
      ? (candidate.code as ProtocolErrorCode)
      : 'UNKNOWN_ERROR';
  return {
    ok: false,
    code,
    messageKey:
      typeof candidate?.messageKey === 'string'
        ? candidate.messageKey
        : `room.error.${code.toLowerCase()}`,
    ...(candidate?.params && typeof candidate.params === 'object'
      ? { params: candidate.params as Record<string, string | number> }
      : {}),
    ...(Array.isArray(candidate?.issues) ? { issues: candidate.issues } : {}),
  };
};

const mutationRevision = (
  request: V3Command,
): { expectedRoomRevision: number; commandId: string } | undefined => {
  if (!('expectedRoomRevision' in request.meta)) return undefined;
  if (
    !Number.isSafeInteger(request.meta.expectedRoomRevision) ||
    request.meta.expectedRoomRevision < 1 ||
    typeof request.meta.commandId !== 'string' ||
    request.meta.commandId.length === 0
  ) {
    return undefined;
  }
  return {
    expectedRoomRevision: request.meta.expectedRoomRevision,
    commandId: request.meta.commandId,
  };
};

export function bindSocketTransport(io: Server, rooms: RoomService): void {
  const pushCurrent = async (target: Socket): Promise<void> => {
    const targetState = state(target);
    const identity = targetState.identity;
    if (!identity) return;
    const room = await rooms.get(identity.roomCode, identity.actorId);
    if (room.status !== 'playing' && room.status !== 'ended') return;
    const afterSequence = targetState.lastSequence ?? 0;
    const events = await rooms.events(identity, afterSequence);
    const snapshot = await rooms.snapshot(identity);
    targetState.lastSequence = snapshot.lastSequence;
    target.emit('v3:events', {
      type: 'game.events',
      roomId: snapshot.roomId,
      gameId: snapshot.gameId,
      afterSequence,
      events,
    });
    target.emit('v3:snapshot', {
      type: 'game.snapshot',
      snapshot,
    });
  };

  const pushRoom = async (
    roomCode: string,
    reason: RoomSnapshotReason,
  ): Promise<void> => {
    for (const target of io.sockets.sockets.values()) {
      const targetIdentity = state(target).identity;
      if (targetIdentity?.roomCode !== roomCode) continue;
      try {
        const room = await rooms.get(roomCode, targetIdentity.actorId);
        target.emit('v3:room', { type: 'room.snapshot', room, reason });
        await pushCurrent(target);
      } catch {
        target.emit('v3:error', {
          ok: false,
          code: 'PUSH_FAILED',
          messageKey: 'room.error.push_failed',
        } satisfies ProtocolAckError);
      }
    }
  };

  // Session changes (including AI turns, deadline transitions, and the end
  // of a game) arrive here without a socket command to use as the sender.
  // Push each connection's own projection so players, public spectators,
  // and omniscient monitors never share an authority snapshot.
  rooms.subscribeRoomChanges(pushRoom);

  io.on('connection', (socket) => {
    const bind = async (
      access: RoomAccess,
      actorId: string,
    ): Promise<SocketIdentity> => {
      const identity = await rooms.identity(
        access.room.code,
        actorId,
        access.credentials.resumeToken,
      );
      state(socket).identity = identity;
      state(socket).lastSequence = 0;
      socket.join(`room:${identity.roomCode}`);
      return identity;
    };

    const requireMutation = (request: V3Command): { expectedRoomRevision: number; commandId: string } => {
      const revision = mutationRevision(request);
      if (!revision) throw new RoomServiceError({ code: 'INVALID_COMMAND', messageKey: 'room.error.invalid_command' });
      return revision;
    };

    socket.on(
      'v3:command',
      async (
        request: V3Command & { actorName?: string; avatarId?: string },
        ack?: (response: unknown) => void,
      ) => {
        try {
          const { meta, command } = request;
          if (command.type === 'catalog.get') {
            ack?.({ ok: true, catalog: rooms.getCatalog() });
            return;
          }
          if (command.type === 'room.create') {
            if (state(socket).identity) {
              throw new RoomServiceError({ code: 'IDENTITY_ALREADY_BOUND', messageKey: 'room.error.identity_already_bound' });
            }
            const access = await rooms.create({ actorId: meta.actorId, options: command.payload });
            await bind(access, meta.actorId);
            ack?.({ ok: true, ...access });
            await pushRoom(access.room.code, 'created');
            return;
          }

          if (command.type === 'room.join') {
            if (state(socket).identity) {
              throw new RoomServiceError({ code: 'IDENTITY_ALREADY_BOUND', messageKey: 'room.error.identity_already_bound' });
            }
            const access = await rooms.join({
              actorId: meta.actorId,
              name: request.actorName ?? '玩家',
              avatarId: request.avatarId,
              roomCode: command.payload.roomCode,
              joinToken: command.payload.joinToken,
            });
            await bind(access, meta.actorId);
            ack?.({ ok: true, ...access });
            await pushRoom(access.room.code, 'joined');
            return;
          }

          if (command.type === 'spectator.join') {
            if (state(socket).identity) {
              throw new RoomServiceError({ code: 'IDENTITY_ALREADY_BOUND', messageKey: 'room.error.identity_already_bound' });
            }
            const access = await rooms.join({
              actorId: meta.actorId,
              name: request.actorName ?? '观战者',
              avatarId: request.avatarId,
              roomCode: command.payload.roomCode,
              joinToken: (socket.handshake.auth as { joinToken?: string }).joinToken,
              spectator: true,
              omniscientToken: command.payload.omniscientToken,
            });
            await bind(access, meta.actorId);
            ack?.({ ok: true, ...access });
            await pushRoom(access.room.code, 'joined');
            return;
          }

          if (command.type === 'room.resume' || command.type === 'spectator.resume') {
            if (state(socket).identity) {
              throw new RoomServiceError({ code: 'IDENTITY_ALREADY_BOUND', messageKey: 'room.error.identity_already_bound' });
            }
            const resumeToken = (socket.handshake.auth as { resumeToken?: string }).resumeToken;
            const access = await rooms.resume(command.payload.roomCode, meta.actorId, resumeToken);
            const identity = await bind(access, meta.actorId);
            if (command.type === 'spectator.resume') {
              const events = await rooms.events(identity, command.payload.afterSequence);
              state(socket).lastSequence = events.at(-1)?.sequence ?? command.payload.afterSequence;
              ack?.({ ok: true, ...access, events });
            } else {
              ack?.({ ok: true, ...access });
            }
            await pushRoom(access.room.code, 'reconnected');
            return;
          }

          const identity = state(socket).identity;
          if (!identity) throw new RoomServiceError({ code: 'UNAUTHENTICATED', messageKey: 'room.error.unauthenticated' });
          if (meta.actorId !== identity.actorId) throw new RoomServiceError({ code: 'IDENTITY_MISMATCH', messageKey: 'room.error.identity_mismatch' });
          if ('roomId' in meta && meta.roomId && meta.roomId !== identity.roomId) {
            throw new RoomServiceError({ code: 'ROOM_MISMATCH', messageKey: 'room.error.room_mismatch' });
          }

          if (command.type === 'room.get') {
            if (command.payload.roomCode !== identity.roomCode) {
              throw new RoomServiceError({ code: 'ROOM_MISMATCH', messageKey: 'room.error.room_mismatch' });
            }
            ack?.({ ok: true, room: await rooms.get(identity.roomCode, identity.actorId) });
            return;
          }

          if (isGameCommand(command)) {
            if (!('gameId' in meta) || !('expectedStageRevision' in meta)) {
              throw new RoomServiceError({ code: 'INVALID_GAME_META', messageKey: 'room.error.invalid_game_meta' });
            }
            const result = await rooms.dispatchGame(identity, meta, command);
            if (result.ok) {
              ack?.(result);
              // GameSession persistence notifies the room-change subscriber.
              // That subscriber calls pushRoom, so every authorized socket
              // receives its own player/spectator/monitor projection.  Do not
              // push only the command author's projection here.
            } else {
              ack?.(errorResponse({
                code: result.code,
                messageKey: `game.error.${String(result.code).toLowerCase()}`,
              }));
            }
            return;
          }

          const revision = requireMutation(request);
          let room: RoomView | undefined;
          let reason: Parameters<typeof pushRoom>[1] = 'status_changed';
          switch (command.type) {
            case 'room.update_config':
              room = await rooms.updateConfig(identity, command.payload.config, revision.expectedRoomRevision);
              reason = 'config_changed';
              break;
            case 'room.begin_ready_check':
              room = await rooms.beginReadyCheck(identity, revision.expectedRoomRevision);
              reason = 'status_changed';
              break;
            case 'room.cancel_ready_check':
              room = await rooms.cancelReadyCheck(identity, revision.expectedRoomRevision);
              reason = 'status_changed';
              break;
            case 'room.ready':
              room = await rooms.setReady(identity, command.payload.ready, revision.expectedRoomRevision);
              reason = 'ready_changed';
              break;
            case 'room.start_game':
              room = await rooms.startGame(identity, revision);
              reason = 'status_changed';
              break;
            case 'room.transfer_host':
              room = await rooms.transferHost(identity, command.payload.targetMemberId, revision.expectedRoomRevision);
              reason = 'host_changed';
              break;
            case 'room.leave':
              room = await rooms.leave(identity, revision.expectedRoomRevision);
              socket.leave(`room:${identity.roomCode}`);
              state(socket).identity = undefined;
              break;
            case 'room.dissolve':
              await rooms.dissolve(identity, command.payload.confirm, revision.expectedRoomRevision);
              socket.leave(`room:${identity.roomCode}`);
              state(socket).identity = undefined;
              ack?.({ ok: true });
              return;
          }
          ack?.({ ok: true, ...(room ? { room } : {}) });
          await pushRoom(identity.roomCode, reason);
        } catch (error) {
          ack?.(errorResponse(error));
        }
      },
    );

    socket.on('v3:rooms', async (_request, ack?: (response: unknown) => void) => {
      try {
        ack?.({ ok: true, rooms: await rooms.list() });
      } catch (error) {
        ack?.(errorResponse(error));
      }
    });

    socket.on(
      'v3:snapshot',
      async (
        request: { roomCode?: string; actorId?: string },
        ack?: (response: unknown) => void,
      ) => {
        try {
          const identity = state(socket).identity;
          if (!identity) throw new RoomServiceError({ code: 'UNAUTHENTICATED', messageKey: 'room.error.unauthenticated' });
          if (request.actorId && request.actorId !== identity.actorId) throw new RoomServiceError({ code: 'IDENTITY_MISMATCH', messageKey: 'room.error.identity_mismatch' });
          if (request.roomCode && request.roomCode !== identity.roomCode) throw new RoomServiceError({ code: 'ROOM_MISMATCH', messageKey: 'room.error.room_mismatch' });
          const snapshot = await rooms.snapshot(identity);
          state(socket).lastSequence = snapshot.lastSequence;
          ack?.({ ok: true, snapshot });
        } catch (error) {
          ack?.(errorResponse(error));
        }
      },
    );

    socket.on('disconnect', () => {
      const identity = state(socket).identity;
      if (!identity) return;
      void rooms.disconnect(identity)
        .then(() => pushRoom(identity.roomCode, 'disconnected'))
        .catch(() => undefined);
    });
  });
}
