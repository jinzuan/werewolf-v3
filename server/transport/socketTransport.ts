import type { Server, Socket } from 'socket.io';
import type { GameCommand, V3Command } from '../../shared/protocol';
import type { RoomService } from '../rooms/roomService';
import type { RoomAccess, SocketIdentity } from '../rooms/types';

interface SocketState {
  identity?: SocketIdentity;
  lastSequence?: number;
}

const state = (socket: Socket): SocketState => socket.data as SocketState;

const isGameCommand = (
  command: V3Command['command'],
): command is GameCommand => command.type.startsWith('game.');

const codeOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'UNKNOWN_ERROR';

export function bindSocketTransport(io: Server, rooms: RoomService): void {
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

    const pushCurrent = async (target: Socket): Promise<void> => {
      const targetState = state(target);
      const identity = targetState.identity;
      if (!identity) return;
      const events = await rooms.events(
        identity,
        targetState.lastSequence ?? 0,
      );
      const snapshot = await rooms.snapshot(identity);
      targetState.lastSequence = snapshot.lastSequence;
      target.emit('v3:events', {
        type: 'game.events',
        roomId: snapshot.roomId,
        gameId: snapshot.gameId,
        afterSequence: snapshot.lastSequence,
        events,
      });
      target.emit('v3:snapshot', {
        type: 'game.snapshot',
        snapshot,
      });
    };

    const pushRoom = async (roomCode: string): Promise<void> => {
      for (const target of io.sockets.sockets.values()) {
        if (state(target).identity?.roomCode !== roomCode) continue;
        try {
          await pushCurrent(target);
        } catch {
          target.emit('v3:error', { code: 'PUSH_FAILED' });
        }
      }
    };

    socket.on(
      'v3:command',
      async (
        request: V3Command & { actorName?: string },
        ack?: (response: unknown) => void,
      ) => {
        try {
          const { meta, command } = request;
          if (command.type === 'room.create') {
            if (state(socket).identity) {
              ack?.({ ok: false, code: 'IDENTITY_ALREADY_BOUND' });
              return;
            }
            const access = await rooms.create({
              actorId: meta.actorId,
              options: command.payload,
            });
            await bind(access, meta.actorId);
            ack?.({ ok: true, ...access });
            return;
          }
          if (command.type === 'room.join') {
            if (state(socket).identity) {
              ack?.({ ok: false, code: 'IDENTITY_ALREADY_BOUND' });
              return;
            }
            const access = await rooms.join({
              actorId: meta.actorId,
              name: request.actorName ?? '玩家',
              roomCode: command.payload.roomCode,
              joinToken: command.payload.joinToken,
            });
            await bind(access, meta.actorId);
            ack?.({ ok: true, ...access });
            return;
          }
          if (command.type === 'spectator.join') {
            if (state(socket).identity) {
              ack?.({ ok: false, code: 'IDENTITY_ALREADY_BOUND' });
              return;
            }
            const access = await rooms.join({
              actorId: meta.actorId,
              name: request.actorName ?? '观战者',
              roomCode: command.payload.roomCode,
              joinToken: (socket.handshake.auth as { joinToken?: string })
                .joinToken,
              spectator: true,
              omniscientToken: command.payload.omniscientToken,
            });
            await bind(access, meta.actorId);
            ack?.({ ok: true, ...access });
            return;
          }
          if (command.type === 'spectator.resume') {
            if (state(socket).identity) {
              ack?.({ ok: false, code: 'IDENTITY_ALREADY_BOUND' });
              return;
            }
            const resumeToken = (
              socket.handshake.auth as { resumeToken?: string }
            ).resumeToken;
            const access = await rooms.resume(
              command.payload.roomCode,
              meta.actorId,
              resumeToken,
            );
            const identity = await bind(access, meta.actorId);
            const events = await rooms.events(
              identity,
              command.payload.afterSequence,
            );
            state(socket).lastSequence =
              events.at(-1)?.sequence ?? command.payload.afterSequence;
            ack?.({ ok: true, ...access, events });
            return;
          }

          const identity = state(socket).identity;
          if (!identity) {
            ack?.({ ok: false, code: 'UNAUTHENTICATED' });
            return;
          }
          if (meta.actorId !== identity.actorId) {
            ack?.({ ok: false, code: 'IDENTITY_MISMATCH' });
            return;
          }
          if ('roomId' in meta && meta.roomId && meta.roomId !== identity.roomId) {
            ack?.({ ok: false, code: 'ROOM_MISMATCH' });
            return;
          }

          if (command.type === 'room.start_game') {
            const room = await rooms.startGame(identity);
            ack?.({ ok: true, room });
            await pushRoom(identity.roomCode);
            return;
          }
          if (isGameCommand(command)) {
            if (!('gameId' in meta) || !('expectedStageRevision' in meta)) {
              ack?.({ ok: false, code: 'INVALID_GAME_META' });
              return;
            }
            const result = await rooms.dispatchGame(identity, meta, command);
            ack?.(result);
            if (result.ok) await pushRoom(identity.roomCode);
            return;
          }
          ack?.({ ok: false, code: 'COMMAND_NOT_IMPLEMENTED' });
        } catch (error) {
          ack?.({ ok: false, code: codeOf(error) });
        }
      },
    );

    socket.on('v3:rooms', async (_request, ack?: (response: unknown) => void) => {
      ack?.({ ok: true, rooms: await rooms.list() });
    });

    socket.on(
      'v3:snapshot',
      async (
        request: { roomCode?: string; actorId?: string },
        ack?: (response: unknown) => void,
      ) => {
        try {
          const identity = state(socket).identity;
          if (!identity) {
            ack?.({ ok: false, code: 'UNAUTHENTICATED' });
            return;
          }
          if (request.actorId && request.actorId !== identity.actorId) {
            ack?.({ ok: false, code: 'IDENTITY_MISMATCH' });
            return;
          }
          if (request.roomCode && request.roomCode !== identity.roomCode) {
            ack?.({ ok: false, code: 'ROOM_MISMATCH' });
            return;
          }
          const snapshot = await rooms.snapshot(identity);
          state(socket).lastSequence = snapshot.lastSequence;
          ack?.({ ok: true, snapshot });
        } catch (error) {
          ack?.({ ok: false, code: codeOf(error) });
        }
      },
    );

    socket.on('disconnect', () => {
      const identity = state(socket).identity;
      if (identity) void rooms.disconnect(identity);
    });
  });
}
