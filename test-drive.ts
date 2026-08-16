/**
 * V3 QC driver.
 *
 * The QC entry point composes the same RoomService, GameSession, event store,
 * RuleSet catalog, and deterministic provider used by the application. It
 * only formats the committed event stream for qc.py; it does not implement a
 * second game loop or infer state transitions.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InMemoryEventStore } from './server/events/store';
import { InMemoryRoomRepository } from './server/rooms/repository';
import { RoomService } from './server/rooms/roomService';
import type { DomainEvent } from './shared/events';
import type { Player } from './shared/types';

const args = process.argv.slice(2);
const realRequested = args.includes('--real');
const playerCount = 12;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const playerName = (
  players: readonly Player[],
  id: unknown,
): string => players.find((player) => player.id === id)?.name ?? '未知目标';

const eventDay = (event: DomainEvent): number => {
  const day = event.payload.day;
  return typeof day === 'number' ? day : 0;
};

const eventLine = (event: DomainEvent, players: readonly Player[]): string[] => {
  const payload = event.payload;
  const day = eventDay(event);
  const actor = playerName(players, payload.actorId ?? event.actorId);
  const target = playerName(players, payload.targetId);
  switch (event.eventType) {
    case 'day.speech':
      return [`第${day}天 ${actor}: ${typeof payload.content === 'string' ? payload.content : '（无内容）'}`];
    case 'day.speech_skipped':
      return [`第${day}天 ${actor} 遗言: ${typeof payload.reason === 'string' ? `放弃（理由：${payload.reason}）` : '跳过'}`];
    case 'day.vote_cast':
      return [`第${day}天 ${actor} 投→已锁定（理由：服务端事件已提交）`];
    case 'wolf.message':
      return [`第${day}晚 狼人 ${actor}: ${typeof payload.content === 'string' ? payload.content : '（无内容）'}`];
    case 'wolf.vote_cast':
      return [`第${day}晚 ${actor} 狼人票→${typeof payload.targetName === 'string' ? payload.targetName : target}`];
    case 'wolf.kill_locked':
      return [`第${day}晚 狼人刀杀 ${typeof payload.targetName === 'string' ? payload.targetName : target}`];
    case 'night.resolved': {
      const deaths = Array.isArray(payload.deaths)
        ? payload.deaths.map((id) => playerName(players, id)).join('、')
        : '';
      return [`第${day}晚 ${deaths ? `死亡：${deaths}` : '平安夜'}`];
    }
    case 'hunter.shot':
      return [`第${day}天 ${actor} 开枪→${target}`];
    case 'hunter.shot_skipped':
      return [`第${day}天 ${actor} 放弃开枪`];
    case 'game.ended':
      return [`【公告】游戏结束：${String(payload.winner ?? 'draw')}`];
    default:
      return [];
  }
};

const run = async (): Promise<void> => {
  const repository = new InMemoryRoomRepository();
  const eventStore = new InMemoryEventStore();
  const rooms = new RoomService(repository, eventStore, {
    autoDrive: true,
    environment: 'test',
    deploymentNamespace: 'qc',
    startupGraceMs: 0,
    aiTimeoutMs: 100,
  });
  try {
    const preset = rooms.getCatalog().rolePresets.find((item) => item.enabled);
    if (!preset || preset.playerCount !== playerCount) {
      throw new Error('V3 QC catalog has no enabled twelve-player preset');
    }
    const created = await rooms.create({
      actorId: 'qc-observer',
      createRequestId: `qc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      options: {
        catalogVersion: rooms.getCatalog().catalogVersion,
        roomName: 'V3 QC 对局',
        creator: { name: 'QC 观战者', avatarId: 'avatar-spectator' },
        mode: 'quick_computer',
        visibility: 'invite_only',
        maxPlayers: preset.playerCount,
        minHumanPlayers: 0,
        computerSeats: 0,
        aiFillPolicy: 'fill_to_max',
        roleSetup: { ...preset.roleSetup },
        rolePresetId: preset.id,
        rulesetId: preset.rulesetId,
        rulesetVersion: preset.rulesetVersion,
        readyPolicy: 'all_connected_humans',
        allowPublicSpectators: false,
        reviewEnabled: false,
      },
    });

    const deadline = Date.now() + 10_000;
    let record = await rooms.getRecord(created.room.code);
    while (record?.status !== 'ended' && Date.now() < deadline) {
      await wait(10);
      record = await rooms.getRecord(created.room.code);
    }
    if (!record || record.status !== 'ended' || !record.gameId) {
      throw new Error('V3 QC game did not reach ended');
    }
    const players = record.session?.state.players ?? record.players;
    const stored = eventStore.exportStreams()[`game:${record.gameId}`] ?? [];
    const lines = [
      // --real is retained as the QC entry point, but this headless fixture
      // has no external model credential. Never label deterministic output as
      // real model output.
      '# source template',
      `# 身份表 ${players.map((player) => `${player.name}:${player.role ?? 'unknown'}`).join(', ')}`,
      ...stored.flatMap(({ event }) => eventLine(event, players)),
    ];
    const output = path.join(process.cwd(), 'qc_events.txt');
    await writeFile(output, `${lines.join('\n')}\n`, 'utf8');
    console.log(`[test-drive] V3 event stream written: ${output}`);
    console.log(`[test-drive] players=${players.length}, requestedMode=${realRequested ? 'real (deterministic fixture)' : 'template'}, status=${record.status}, events=${stored.length}`);
  } finally {
    await rooms.close();
  }
};

run().catch((error: unknown) => {
  console.error('[test-drive] V3 QC failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
