import type { Server, Socket } from 'socket.io';
import type {
  GameCommand,
  ProtocolAckError,
  ProtocolErrorCode,
  RoomSnapshotReason,
  RoomMutationCommand,
  V3Command,
} from '../../shared/protocol';
import type { RoomAccess, SocketIdentity } from '../rooms/types';
import { RoomService, RoomServiceError } from '../rooms/roomService';
import {
  isSecureRequest,
  isAllowedOrigin,
  type RuntimeSecurityConfig,
} from '../security/runtimeSecurityConfig';

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
  'IDEMPOTENCY_KEY_REUSED',
  'AI_ENDPOINT_NOT_ALLOWED',
  'AI_PROVIDER_REQUIRED',
  'INSECURE_TRANSPORT',
  'SECRET_STORE_UNAVAILABLE',
  'LEGACY_SECRET_DATA',
  'UNKNOWN_ERROR',
]);

export interface SocketTransportOptions {
  /** Test-only fault injection: commit create, then discard exactly one ACK. */
  dropCreateAckOnce?: boolean;
  /** Test-only fault injection for mutation ACK/push reconciliation. */
  dropMutationAckOnce?: boolean;
  dropMutationPushOnce?: boolean;
  security?: RuntimeSecurityConfig;
}

export type TestFault =
  | 'create_ack'
  | 'mutation_ack'
  | 'mutation_push'
  | 'provider'
  | 'write';

export interface SocketTransportController {
  setFault(fault: TestFault, enabled: boolean): void;
  clearFaults(): void;
}

const errorResponse = (error: unknown): ProtocolAckError => {
  if (error instanceof RoomServiceError) {
    return {
      ok: false,
      code: error.code,
      messageKey: error.messageKey,
      ...(error.params ? { params: error.params } : {}),
      ...(error.issues ? { issues: error.issues } : {}),
      ...(error.receipt ? { receipt: error.receipt } : {}),
    };
  }
  const candidate = error as {
    code?: unknown;
    messageKey?: unknown;
    params?: unknown;
    issues?: unknown;
    retryable?: unknown;
    receipt?: unknown;
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
    ...(typeof candidate?.retryable === 'boolean' ? { retryable: candidate.retryable } : {}),
    ...(candidate?.receipt && typeof candidate.receipt === 'object'
      ? { receipt: candidate.receipt as ProtocolAckError['receipt'] }
      : {}),
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

export function bindSocketTransport(
  io: Server,
  rooms: RoomService,
  options: SocketTransportOptions = {},
): SocketTransportController {
  let dropCreateAck =
    (process.env.NODE_ENV === 'test' || process.env.WW_ENV === 'test') &&
    (options.dropCreateAckOnce === true || process.env.WW_TEST_DROP_CREATE_ACK_ONCE === '1');
  let dropMutationAck = options.dropMutationAckOnce === true;
  let dropMutationPush = options.dropMutationPushOnce === true;
  const mutationPushBlocked = new Set<string>();
  const deferredRoomPushes = new Map<string, {
    reason: RoomSnapshotReason;
    causeCommandId?: string;
  }>();
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
    causeCommandId?: string,
  ): Promise<void> => {
    if (mutationPushBlocked.has(roomCode.toUpperCase())) {
      deferredRoomPushes.set(roomCode.toUpperCase(), {
        reason,
        ...(causeCommandId ? { causeCommandId } : {}),
      });
      return;
    }
    for (const target of io.sockets.sockets.values()) {
      const targetIdentity = state(target).identity;
      if (targetIdentity?.roomCode !== roomCode) continue;
      try {
        const room = await rooms.get(roomCode, targetIdentity.actorId);
        if (dropMutationPush) {
          dropMutationPush = false;
          continue;
        }
        target.emit('v3:room', {
          type: 'room.snapshot',
          room,
          reason,
          ...(causeCommandId ? { causeCommandId } : {}),
        });
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
  rooms.subscribeRoomDissolved(async (roomCode, roomId, causeCommandId) => {
    for (const target of io.sockets.sockets.values()) {
      const targetState = state(target);
      if (targetState.identity?.roomCode !== roomCode) continue;
      target.emit('v3:room.closed', {
        type: 'room.closed',
        roomCode,
        roomId,
        reason: 'dissolved',
        ...(causeCommandId ? { causeCommandId } : {}),
      });
      const targetIdentity = targetState.identity;
      target.leave(`room:${roomCode}`);
      targetState.identity = undefined;
      await rooms.disconnect(targetIdentity!, target.id).catch(() => undefined);
    }
  });

  io.on('connection', (socket) => {
    if (options.security) {
      const origin = socket.handshake.headers.origin;
      if (
        (origin && !isAllowedOrigin(origin, options.security)) ||
        (options.security.environment === 'production' && !isSecureRequest(socket.request, options.security))
      ) {
        socket.disconnect(true);
        return;
      }
    }
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
      await rooms.bindConnection(identity, socket.id);
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
            const payload = command.payload as unknown as {
              createRequestId?: unknown;
              options?: unknown;
            };
            const optionsPayload =
              payload.options && typeof payload.options === 'object'
                ? payload.options
                : command.payload;
            const createRequestId =
              typeof payload.createRequestId === 'string' && payload.createRequestId.trim()
                ? payload.createRequestId
                : meta.commandId;
            const access = await rooms.create({
              actorId: meta.actorId,
              createRequestId,
              options: optionsPayload as Parameters<RoomService['create']>[0]['options'],
            });
            await bind(access, meta.actorId);
            if (dropCreateAck) {
              dropCreateAck = false;
            } else {
              ack?.({ ok: true, ...access });
            }
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

          if (command.type === 'room.ai_config.get') {
            ack?.({ ok: true, summary: await rooms.getAIConfig(identity) });
            return;
          }

          if (command.type === 'room.command_receipt') {
            ack?.({
              ok: true,
              receipt: await rooms.commandReceipt(identity, command.payload.commandId) ?? null,
            });
            return;
          }

          if (command.type === 'review.get') {
            if (command.payload.roomCode !== identity.roomCode) {
              throw new RoomServiceError({ code: 'ROOM_MISMATCH', messageKey: 'room.error.room_mismatch' });
            }
            ack?.({ ok: true, review: await rooms.review(identity) });
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

          if (!command.type.startsWith('room.')) {
            throw new RoomServiceError({ code: 'COMMAND_NOT_IMPLEMENTED', messageKey: 'room.error.command_not_implemented' });
          }

          const revision = requireMutation(request);
          mutationPushBlocked.add(identity.roomCode.toUpperCase());
          const result = await rooms.runRoomMutation(
            identity,
            revision.commandId,
            revision.expectedRoomRevision,
            command as RoomMutationCommand,
          );
          const reason: Parameters<typeof pushRoom>[1] =
            command.type === 'room.update_config' || command.type === 'room.update_ai_config'
              ? 'config_changed'
              : command.type === 'room.ready'
                ? 'ready_changed'
                : command.type === 'room.transfer_host'
                  ? 'host_changed'
                  : command.type === 'room.leave'
                    ? 'left'
                    : 'status_changed';
          // ACK is the first externally visible outcome. Pushes and identity
          // detachment happen only after the receipt has reached the caller.
          if (dropMutationAck) {
            dropMutationAck = false;
          } else {
            ack?.({
              ok: true,
              receipt: result.receipt,
              ...(result.room ? { room: result.room } : {}),
              ...(result.summary !== undefined ? { summary: result.summary } : {}),
              ...(result.roomRevision !== undefined ? { roomRevision: result.roomRevision } : {}),
            });
          }
          if (result.tombstone) {
            mutationPushBlocked.delete(identity.roomCode.toUpperCase());
            deferredRoomPushes.delete(identity.roomCode.toUpperCase());
            await rooms.publishRoomClosed(result.tombstone);
            return;
          }
          if (command.type === 'room.leave') {
            socket.leave(`room:${identity.roomCode}`);
            state(socket).identity = undefined;
          }
          mutationPushBlocked.delete(identity.roomCode.toUpperCase());
          deferredRoomPushes.delete(identity.roomCode.toUpperCase());
          await pushRoom(identity.roomCode, reason, revision.commandId);
        } catch (error) {
          mutationPushBlocked.delete(state(socket).identity?.roomCode?.toUpperCase() ?? '');
          const response = errorResponse(error);
          ack?.(response);
        }
      },
    );

    socket.on('v3:rooms', async (_request, ack?: (response: unknown) => void) => {
      try {
        ack?.({ ok: true, rooms: await rooms.listPublicRooms() });
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
      void rooms.disconnect(identity, socket.id)
        .then(() => pushRoom(identity.roomCode, 'disconnected'))
        .catch(() => undefined);
    });
  });

  return {
    setFault: (fault, enabled) => {
      if (fault === 'create_ack') dropCreateAck = enabled;
      if (fault === 'mutation_ack') dropMutationAck = enabled;
      if (fault === 'mutation_push') dropMutationPush = enabled;
    },
    clearFaults: () => {
      dropCreateAck = false;
      dropMutationAck = false;
      dropMutationPush = false;
      mutationPushBlocked.clear();
      deferredRoomPushes.clear();
    },
  };
}
