import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { EventStore, ViewerContext } from '../../shared/events';
import type { GameCommand, GameCommandMeta, RoomSummary } from '../../shared/protocol';
import type { Player } from '../../shared/types';
import type { AIProvider } from '../ai/types';
import { AIOrchestrator } from '../ai/orchestrator';
import { DeterministicAIProvider } from '../ai/deterministicProvider';
import { buildAIRuntimeContext } from '../ai/runtimeContext';
import { GameSession } from '../session/gameSession';
import type { SessionOptions } from '../session/types';
import type { RoomRepository } from './repository';
import {
  ROLE_DECK,
  type CreateRoomRequest,
  type JoinRoomRequest,
  type RoomAccess,
  type RoomRecord,
  type RoomView,
  type SocketIdentity,
} from './types';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const token = () => randomBytes(24).toString('base64url');
const code = () =>
  Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join(
    '',
  );

const makePlayer = (
  roomId: string,
  id: string,
  name: string,
  order: number,
  isAI: boolean,
): Player => ({
  id,
  roomId,
  name,
  isAI,
  role: null,
  isAlive: true,
  isHost: order === 1,
  order,
  isReady: isAI,
});

export interface RoomServiceOptions {
  session?: Omit<SessionOptions, 'onChanged'>;
  aiProvider?: AIProvider;
  aiTimeoutMs?: number;
  autoDrive?: boolean;
}

export class RoomService {
  private readonly sessions = new Map<string, GameSession>();
  private readonly aiRuns = new Map<string, Promise<void>>();
  private readonly aiProvider: AIProvider;
  private closed = false;

  constructor(
    private readonly repository: RoomRepository,
    private readonly eventStore: EventStore,
    private readonly options: RoomServiceOptions = {},
  ) {
    this.aiProvider = options.aiProvider ?? new DeterministicAIProvider();
  }

  async restore(): Promise<number> {
    this.closed = false;
    const rooms = await this.repository.list();
    for (const room of rooms) {
      this.migrateRoom(room);
      if (!room.session || room.status === 'ended') {
        await this.repository.save(room);
        continue;
      }
      const recoverySnapshot = structuredClone(room.session);
      const existingEvents = await this.eventStore.read(
        `game:${recoverySnapshot.state.gameId}`,
      );
      if (existingEvents.length === 0) {
        recoverySnapshot.state.streamVersion = 0;
      }
      const session = this.createSession(room, recoverySnapshot);
      if (existingEvents.length === 0) await session.initialize();
      session.restoreScheduling();
      room.session = session.serialize();
      this.sessions.set(room.code, session);
      await this.repository.save(room);
      this.startAI(room.code, room.auto);
    }
    return this.sessions.size;
  }

  async create(request: CreateRoomRequest): Promise<RoomAccess> {
    const roomId = randomUUID();
    const roomCode = await this.uniqueCode();
    const host = makePlayer(
      roomId,
      request.actorId,
      request.options.name.trim().slice(0, 32) || '房主',
      1,
      false,
    );
    const resumeToken = token();
    const room: RoomRecord = {
      id: roomId,
      code: roomCode,
      name: request.options.roomName.trim().slice(0, 64) || 'V3 房间',
      joinToken: token(),
      omniscientToken: token(),
      hostId: request.actorId,
      maxPlayers: 12,
      status: 'waiting',
      auto: request.options.auto ?? false,
      debugMode: request.options.debugMode ?? false,
      members: [
        {
          id: request.actorId,
          name: host.name,
          kind: request.options.spectator ? 'spectator' : 'player',
          connected: true,
          omniscient: request.options.auto ?? false,
          resumeToken,
        },
      ],
      players: request.options.spectator ? [] : [host],
      createdAt: Date.now(),
    };
    if (room.auto) {
      room.players = [];
      this.fillAIPlayers(room);
      await this.repository.save(room);
      await this.start(room);
    }
    await this.repository.save(room);
    this.startAI(room.code, room.auto);
    return {
      room: this.projectRoom(room, request.actorId),
      credentials: {
        resumeToken,
        joinToken: room.joinToken,
        ...(room.members[0].omniscient
          ? { omniscientToken: room.omniscientToken }
          : {}),
      },
    };
  }

  async join(request: JoinRoomRequest): Promise<RoomAccess> {
    const room = await this.requireRoom(request.roomCode);
    if (room.joinToken !== request.joinToken) {
      throw new Error('ROOM_TOKEN_INVALID');
    }
    if (room.members.some((member) => member.id === request.actorId)) {
      throw new Error('IDENTITY_ALREADY_EXISTS');
    }

    const spectator = request.spectator || room.status !== 'waiting';
    if (!spectator && room.players.length >= room.maxPlayers) {
      throw new Error('ROOM_FULL');
    }
    const resumeToken = token();
    room.members.push({
      id: request.actorId,
      name: request.name.trim().slice(0, 32) || '玩家',
      kind: spectator ? 'spectator' : 'player',
      connected: true,
      omniscient:
        spectator &&
        request.omniscientToken !== undefined &&
        request.omniscientToken === room.omniscientToken,
      resumeToken,
    });
    if (!spectator) {
      room.players.push(
        makePlayer(
          room.id,
          request.actorId,
          request.name,
          room.players.length + 1,
          false,
        ),
      );
    }
    await this.repository.save(room);
    return {
      room: this.projectRoom(room, request.actorId),
      credentials: { resumeToken },
    };
  }

  async resume(
    roomCode: string,
    actorId: string,
    resumeToken?: string,
  ): Promise<RoomAccess> {
    const room = await this.requireRoom(roomCode);
    const member = room.members.find((item) => item.id === actorId);
    if (!member || !resumeToken || member.resumeToken !== resumeToken) {
      throw new Error('UNAUTHENTICATED');
    }
    member.connected = true;
    await this.repository.save(room);
    return {
      room: this.projectRoom(room, actorId),
      credentials: { resumeToken: member.resumeToken },
    };
  }

  async identity(
    roomCode: string,
    actorId: string,
    resumeToken: string,
  ): Promise<SocketIdentity> {
    const room = await this.requireRoom(roomCode);
    const member = room.members.find(
      (item) => item.id === actorId && item.resumeToken === resumeToken,
    );
    if (!member) throw new Error('UNAUTHENTICATED');
    return {
      actorId,
      roomCode: room.code,
      roomId: room.id,
      kind: member.kind,
      omniscient: member.omniscient,
      resumeToken,
      gameId: room.session?.state.gameId,
    };
  }

  async disconnect(identity: SocketIdentity): Promise<void> {
    const room = await this.requireRoom(identity.roomCode);
    const member = room.members.find((item) => item.id === identity.actorId);
    if (!member) return;
    member.connected = false;
    await this.repository.save(room);
  }

  async list(): Promise<RoomSummary[]> {
    return (await this.repository.list()).map((room) => ({
      roomCode: room.code,
      roomName: room.name,
      status: room.status,
      playerCount: room.players.length,
      maxPlayers: room.maxPlayers,
      onlinePlayers: room.members.filter(
        (member) => member.kind === 'player' && member.connected,
      ).length,
      spectatorCount: room.members.filter(
        (member) => member.kind === 'spectator',
      ).length,
      auto: room.auto,
      debugMode: room.debugMode,
    }));
  }

  async startGame(
    identity: SocketIdentity,
  ): Promise<RoomView> {
    const room = await this.requireRoom(identity.roomCode);
    this.assertIdentityRoom(identity, room);
    if (room.hostId !== identity.actorId) throw new Error('HOST_REQUIRED');
    if (identity.kind !== 'player') throw new Error('SPECTATOR_READ_ONLY');
    if (room.status !== 'waiting') throw new Error('GAME_ALREADY_STARTED');
    this.fillAIPlayers(room);
    await this.start(room);
    await this.repository.save(room);
    this.startAI(room.code, room.auto);
    return this.projectRoom(room, identity.actorId);
  }

  async dispatchGame(
    identity: SocketIdentity,
    meta: GameCommandMeta,
    command: GameCommand,
  ) {
    const room = await this.requireRoom(identity.roomCode);
    this.assertIdentityRoom(identity, room);
    if (identity.kind !== 'player') {
      return { ok: false, code: 'SPECTATOR_READ_ONLY', events: [] };
    }
    if (meta.roomId !== room.id) {
      return { ok: false, code: 'ROOM_MISMATCH', events: [] };
    }
    if (meta.gameId !== room.session?.state.gameId) {
      return { ok: false, code: 'GAME_MISMATCH', events: [] };
    }
    if (meta.actorId !== identity.actorId) {
      return { ok: false, code: 'IDENTITY_MISMATCH', events: [] };
    }
    const session = this.sessions.get(room.code);
    if (!session) throw new Error('GAME_NOT_STARTED');
    const result = await session.dispatch(
      { ...meta, actorId: identity.actorId, roomId: room.id },
      command,
    );
    room.session = session.serialize();
    room.players = session.players;
    if (room.session.state.gameState.phase === 'ended') room.status = 'ended';
    await this.repository.save(room);
    const viewer = await this.viewerForIdentity(identity);
    return {
      ...result,
      events: await session.projectEvents(result.events, viewer),
    };
  }

  async viewerForIdentity(identity: SocketIdentity): Promise<ViewerContext> {
    const room = await this.requireRoom(identity.roomCode);
    this.assertIdentityRoom(identity, room);
    if (identity.kind === 'spectator') {
      return {
        kind: 'spectator',
        spectatorId: identity.actorId,
        omniscient: identity.omniscient,
      };
    }
    const player = room.players.find((item) => item.id === identity.actorId);
    if (!player?.role) throw new Error('ROLE_NOT_ASSIGNED');
    return { kind: 'player', playerId: identity.actorId, role: player.role };
  }

  async snapshot(identity: SocketIdentity) {
    const room = await this.requireRoom(identity.roomCode);
    this.assertIdentityRoom(identity, room);
    const session = this.sessions.get(room.code);
    if (!session) throw new Error('GAME_NOT_STARTED');
    return session.snapshotFor(await this.viewerForIdentity(identity));
  }

  async events(identity: SocketIdentity, afterSequence = 0) {
    const room = await this.requireRoom(identity.roomCode);
    this.assertIdentityRoom(identity, room);
    const session = this.sessions.get(room.code);
    if (!session) throw new Error('GAME_NOT_STARTED');
    return session.eventsFor(
      await this.viewerForIdentity(identity),
      afterSequence,
    );
  }

  async get(roomCode: string, actorId: string): Promise<RoomView> {
    return this.projectRoom(await this.requireRoom(roomCode), actorId);
  }

  async getRecord(roomCode: string): Promise<RoomRecord | undefined> {
    return this.repository.get(roomCode);
  }

  session(roomCode: string): GameSession | undefined {
    return this.sessions.get(roomCode.toUpperCase());
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const session of this.sessions.values()) session.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    this.aiRuns.clear();
  }

  private createSession(
    room: RoomRecord,
    snapshot?: RoomRecord['session'],
  ): GameSession {
    return new GameSession(room.id, room.players, this.eventStore, snapshot, {
      ...this.options.session,
      onChanged: async (session) => {
        const current = await this.requireRoom(room.code);
        current.session = session.serialize();
        current.players = session.players;
        if (current.session.state.gameState.phase === 'ended') {
          current.status = 'ended';
        }
        await this.repository.save(current);
        this.startAI(current.code, current.auto);
      },
    });
  }

  private async start(room: RoomRecord): Promise<void> {
    room.players = room.players.map((player, index) => ({
      ...player,
      role: ROLE_DECK[index] ?? 'villager',
      isReady: true,
    }));
    room.status = 'playing';
    const session = this.createSession(room);
    this.sessions.set(room.code, session);
    await session.initialize();
    room.session = session.serialize();
  }

  private startAI(roomCode: string, autoRoom = false): void {
    if (
      this.closed ||
      this.options.autoDrive === false ||
      (!autoRoom && this.options.autoDrive !== true)
    ) {
      return;
    }
    if (this.aiRuns.has(roomCode)) return;
    const run = this.driveAI(roomCode).finally(() => {
      this.aiRuns.delete(roomCode);
    });
    this.aiRuns.set(roomCode, run);
  }

  private async driveAI(roomCode: string): Promise<void> {
    for (let step = 0; step < 2_000; step += 1) {
      if (this.closed) return;
      const room = await this.requireRoom(roomCode);
      const session = this.sessions.get(room.code);
      if (!session || room.status !== 'playing') return;
      const state = session.serialize().state;
      const actorEntry = state.gameState.allowedActors?.find((entry) =>
        state.players.find(
          (player) => player.id === entry.playerId && player.isAI,
        ),
      );
      if (!actorEntry) return;
      const actor = state.players.find(
        (player) => player.id === actorEntry.playerId,
      );
      if (!actor?.role) return;
      const projectedPlayers = this.projectAIPlayers(state.players, actor.id, actor.role);
      const promptContext = this.aiProvider.requiresPromptContext
        ? buildAIRuntimeContext({
            actorId: actor.id,
            role: actor.role,
            phase: state.gameState.phase,
            stage:
              state.gameState.phase === 'night'
                ? state.night.stage
                : state.dayFlow.stage,
            dayNumber: state.gameState.day,
            roundNumber:
              state.gameState.phase === 'voting'
                ? state.dayFlow.voteRound
                : state.gameState.phase === 'night'
                  ? state.gameState.wolfDiscussionRound
                  : state.gameState.dayPhase?.discussionRounds || 1,
            players: projectedPlayers,
            visibleEvents: await session.eventsFor({
              kind: 'player',
              playerId: actor.id,
              role: actor.role,
            }),
            allowedActions: actorEntry.actions,
            voteCandidates: state.dayFlow.voteCandidates,
            guardianLastTarget: state.gameState.guardianLastTarget,
            witchHasHealPotion: state.gameState.witchHasHealPotion,
            witchHasPoisonPotion: state.gameState.witchHasPoisonPotion,
            hunterShotAvailable: actorEntry.actions.includes('hunter_shoot'),
            wolfVoteRound: state.gameState.wolfDiscussionRound,
          })
        : undefined;
      const orchestrator = new AIOrchestrator(
        this.aiProvider,
        this.options.session?.now,
        {
          timeoutMs: this.options.aiTimeoutMs,
        },
      );
      await orchestrator.act(session, {
        roomId: room.id,
        gameId: session.gameId,
        playerId: actor.id,
        role: actor.role,
        phase: state.gameState.phase,
        stage:
          state.gameState.phase === 'night'
            ? state.night.stage
            : state.dayFlow.stage,
        stageRevision: session.stageRevision,
        players: projectedPlayers,
        allowedActions: [...actorEntry.actions],
        allowedCommandTypes: actorEntry.actions.map((action) =>
          this.commandTypeForAction(action),
        ),
        ...(promptContext ? { promptContext } : {}),
      });
      room.session = session.serialize();
      room.players = session.players;
      if (room.session.state.gameState.phase === 'ended') room.status = 'ended';
      await this.repository.save(room);
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('AI_STEP_LIMIT_EXCEEDED');
  }

  private projectAIPlayers(
    players: readonly Player[],
    actorId: string,
    role: NonNullable<Player['role']>,
  ): Player[] {
    return players.map((player) => ({
      ...player,
      role:
        player.id === actorId || (role === 'wolf' && player.role === 'wolf')
          ? player.role
          : null,
      aiConfig: undefined,
    }));
  }

  private commandTypeForAction(
    action: NonNullable<RoomView['viewer']['allowedActions']>[number],
  ): GameCommand['type'] {
    switch (action) {
      case 'guard':
      case 'check':
      case 'heal':
      case 'poison':
        return 'game.night_action';
      case 'wolf_speak':
        return 'game.wolf_speak';
      case 'wolf_vote':
        return 'game.wolf_vote';
      case 'skip_night':
        return 'game.skip_night';
      case 'speak':
        return 'game.speak';
      case 'skip_speech':
        return 'game.skip_speech';
      case 'vote':
      case 'abstain':
        return 'game.vote';
      case 'hunter_shoot':
      case 'skip_hunter_shot':
        return 'game.hunter_shoot';
    }
  }

  private projectRoom(room: RoomRecord, actorId: string): RoomView {
    const member = room.members.find((item) => item.id === actorId);
    if (!member) throw new Error('UNAUTHENTICATED');
    const allowedActions =
      room.session?.state.gameState.allowedActors?.find(
        (entry) => entry.playerId === actorId,
      )?.actions ?? [];
    return {
      id: room.id,
      code: room.code,
      name: room.name,
      hostId: room.hostId,
      maxPlayers: room.maxPlayers,
      status: room.status,
      auto: room.auto,
      debugMode: room.debugMode,
      members: room.members.map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        connected: item.connected,
        isHost: item.id === room.hostId,
      })),
      viewer: {
        actorId,
        kind: member.kind,
        omniscient: member.omniscient,
        canStart:
          member.kind === 'player' &&
          room.hostId === actorId &&
          room.status === 'waiting',
        canSubmitGameCommands:
          member.kind === 'player' && room.status === 'playing',
        allowedActions: [...allowedActions],
      },
      ...(room.session ? { gameId: room.session.state.gameId } : {}),
      createdAt: room.createdAt,
    };
  }

  private fillAIPlayers(room: RoomRecord): void {
    while (room.players.length < room.maxPlayers) {
      const order = room.players.length + 1;
      const id = `ai-${room.id.slice(0, 8)}-${order}`;
      const player = makePlayer(room.id, id, `AI ${order}`, order, true);
      room.players.push(player);
      room.members.push({
        id,
        name: player.name,
        kind: 'player',
        connected: true,
        omniscient: false,
        resumeToken: token(),
      });
    }
  }

  private assertIdentityRoom(
    identity: SocketIdentity,
    room: RoomRecord,
  ): void {
    if (identity.roomId !== room.id || identity.roomCode !== room.code) {
      throw new Error('ROOM_MISMATCH');
    }
    const member = room.members.find(
      (item) =>
        item.id === identity.actorId &&
        item.resumeToken === identity.resumeToken &&
        item.kind === identity.kind,
    );
    if (!member) throw new Error('UNAUTHENTICATED');
  }

  private migrateRoom(room: RoomRecord): void {
    for (const member of room.members) member.resumeToken ??= token();
  }

  private async requireRoom(codeOrId: string): Promise<RoomRecord> {
    const direct = await this.repository.get(codeOrId);
    if (direct) {
      this.migrateRoom(direct);
      return direct;
    }
    const room = (await this.repository.list()).find(
      (item) => item.id === codeOrId,
    );
    if (!room) throw new Error('ROOM_NOT_FOUND');
    this.migrateRoom(room);
    return room;
  }

  private async uniqueCode(): Promise<string> {
    let candidate = code();
    while (await this.repository.get(candidate)) candidate = code();
    return candidate;
  }
}
