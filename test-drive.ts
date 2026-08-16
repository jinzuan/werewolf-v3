/**
 * V3 headless QC driver.
 *
 * The QC process deliberately uses the same composition root and RoomService
 * as production and browser tests.  It only supplies test ports (an in-memory
 * repository/event stream and a short stage clock); no rules are reimplemented
 * in this file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createV3Application } from './server/app/createV3Application';
import { resolveRuntimeConfig } from './server/runtimeConfig';
import { RoomCatalogService } from './server/rooms/roomCatalogService';
import type { StoredEvent } from './shared/events';
import type { CreateRoomOptionsV31 } from './shared/roomContract';
import type { Role, Player } from './shared/types';

const args = process.argv.slice(2);
const realRequested = args.includes('--real');
const countArg = args.find((value) => /^\d+$/.test(value));
const playerCount = Math.min(Math.max(Number(countArg) || 12, 4), 12);

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const playerName = (players: readonly Player[], id: unknown): string =>
  typeof id === 'string'
    ? players.find((player) => player.id === id)?.name ?? id
    : '未知玩家';

const payloadOf = (event: StoredEvent): Record<string, unknown> =>
  event.event.payload as Record<string, unknown>;

const numberValue = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const eventDay = (
  event: StoredEvent,
  currentDay: number,
): number => numberValue(payloadOf(event).day, currentDay);

const roleName = (role: Role | null): string => role ?? 'unknown';

const causeName = (cause: unknown): string => {
  switch (cause) {
    case 'wolf_kill': return '狼刀';
    case 'poison': return '毒药';
    case 'exile': return '放逐';
    case 'hunter_shot': return '猎人枪';
    default: return '夜间行动';
  }
};

const latestStateBefore = (
  events: readonly StoredEvent[],
  index: number,
): Record<string, unknown> | undefined => {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (events[cursor].event.eventType !== 'game.state_updated') continue;
    const state = payloadOf(events[cursor]).gameState;
    return state && typeof state === 'object' ? state as Record<string, unknown> : undefined;
  }
  return undefined;
};

/** Render the authoritative V3 event stream into the long-standing QC text format. */
const renderQcLines = (events: StoredEvent[], players: Player[]): string[] => {
  const lines: string[] = [];
  let currentDay = 1;
  const stateByCorrelation = new Map<string, Record<string, unknown>>();
  for (const stored of events) {
    if (stored.event.eventType !== 'game.state_updated') continue;
    const state = payloadOf(stored).gameState;
    if (state && typeof state === 'object') {
      const value = state as Record<string, unknown>;
      currentDay = numberValue(value.day, currentDay);
      stateByCorrelation.set(stored.event.correlationId, value);
    }
  }

  const name = (id: unknown): string => playerName(players, id);
  const stateFor = (stored: StoredEvent, index: number): Record<string, unknown> =>
    stateByCorrelation.get(stored.event.correlationId) ?? latestStateBefore(events, index) ?? {};

  events.forEach((stored, index) => {
    const event = stored.event;
    const item = payloadOf(stored);
    if (event.eventType === 'game.state_updated') {
      currentDay = numberValue((item.gameState as Record<string, unknown> | undefined)?.day, currentDay);
      return;
    }
    const day = eventDay(stored, currentDay);
    currentDay = day;
    switch (event.eventType) {
      case 'wolf.message':
        lines.push(`第${day}天 ${name(item.actorId ?? event.actorId)}: ${String(item.content ?? '')}`);
        break;
      case 'day.speech':
        lines.push(
          item.lastWords === true
            ? `第${day}天 ${name(item.actorId ?? event.actorId)} 遗言: ${String(item.content ?? '')}`
            : `第${day}天 ${name(item.actorId ?? event.actorId)}: ${String(item.content ?? '')}`,
        );
        break;
      case 'day.speech_skipped':
        if (item.lastWords === true) {
          lines.push(`第${day}天 ${name(item.actorId ?? event.actorId)} 遗言: ${String(item.reason ?? '无新的信息可补充')}`);
        }
        break;
      case 'wolf.vote_cast':
        lines.push(`第${day}天 ${name(item.actorId ?? event.actorId)} 投→${name(item.targetId)}（理由：狼队按当前信息锁定刀口）`);
        break;
      case 'wolf.kill_locked':
        lines.push(`第${day}晚 狼人刀杀 ${name(item.targetId)}`);
        break;
      case 'day.vote_cast': {
        const state = stateFor(stored, index);
        const votes = state.votes;
        const target = votes && typeof votes === 'object'
          ? (votes as Record<string, unknown>)[String(item.actorId ?? event.actorId)]
          : null;
        lines.push(`第${day}天 ${name(item.actorId ?? event.actorId)} 投→${name(target)}（理由：按公开信息作出本轮判断）`);
        break;
      }
      case 'day.exiled':
        lines.push(`【公告】第${day}天 被投票出局：${name(item.playerId)}`);
        break;
      case 'day.no_exile':
        lines.push(`第${day}天 无人得票，本轮无人出局`);
        break;
      case 'day.revote_required':
        lines.push(`第${day}天 平票，进入重新投票`);
        break;
      case 'night.resolved': {
        const deaths = Array.isArray(item.deaths) ? item.deaths.filter((value): value is string => typeof value === 'string') : [];
        if (deaths.length === 0) {
          lines.push(`【公告】第${day}晚 平安夜`);
          break;
        }
        const detail = events.find((candidate) =>
          candidate.event.eventType === 'night.resolution_detail' &&
          candidate.event.correlationId === event.correlationId,
        );
        const records = Array.isArray(detail ? payloadOf(detail).deaths : undefined)
          ? payloadOf(detail!).deaths as Array<Record<string, unknown>>
          : [];
        for (const id of deaths) {
          const record = records.find((candidate) => candidate.playerId === id);
          lines.push(`【公告】第${day}晚 死亡：${name(id)}（${causeName(record?.cause)}）`);
        }
        break;
      }
      case 'hunter.shot':
        lines.push(`【公告】第${day}天 死亡：${name(item.targetId)}（猎人枪）`);
        break;
      case 'game.ended': {
        const winner = item.winner === 'wolf' ? '狼人阵营' : item.winner === 'good' ? '好人阵营' : '平局';
        lines.push(`第${day}天 游戏结束：${winner}获胜`);
        break;
      }
      default:
        break;
    }
  });
  return lines;
};

const makeOptions = (): CreateRoomOptionsV31 => {
  const catalog = new RoomCatalogService().getCatalog();
  const preset = catalog.rolePresets.find((item) => item.enabled);
  if (!preset) throw new Error('QC_ROLE_PRESET_UNAVAILABLE');
  return {
    catalogVersion: catalog.catalogVersion,
    roomName: 'V3 QC 模拟局',
    creator: { name: 'QC 观察员', avatarId: 'avatar-qc' },
    mode: 'quick_computer',
    visibility: 'invite_only',
    maxPlayers: playerCount,
    minHumanPlayers: 0,
    computerSeats: 0,
    aiFillPolicy: 'fill_to_max',
    roleSetup: { ...preset.roleSetup },
    rolePresetId: preset.id,
    rulesetId: preset.rulesetId,
    rulesetVersion: preset.rulesetVersion,
    readyPolicy: 'all_connected_humans',
    allowPublicSpectators: false,
    reviewEnabled: true,
  };
};

const main = async (): Promise<void> => {
  if (realRequested) {
    console.warn('[test-drive] --real 需要显式配置 V3 AI port；本 QC 运行保持 test-deterministic，未伪称真实模型。');
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-v3-qc-'));
  const runtime = resolveRuntimeConfig({
    WW_ENV: 'test',
    WW_DATA_DIR: dataDir,
    WW_DEPLOYMENT_NAMESPACE: 'qc',
  });
  const application = createV3Application(runtime, {
    autoDrive: true,
    roomOptions: {
      aiTimeoutMs: 100,
      session: {
        stageDurationMs: 1_000,
        rng: () => 0.25,
      },
    },
  });
  await application.start();
  try {
    const created = await application.rooms.create({
      actorId: 'qc-observer',
      createRequestId: `qc-${Date.now()}`,
      options: makeOptions(),
    });
    const deadline = Date.now() + 180_000;
    let record = await application.rooms.getRecord(created.room.code);
    while (record?.status !== 'ended' && Date.now() < deadline) {
      await sleep(20);
      record = await application.rooms.getRecord(created.room.code);
    }
    if (!record || record.status !== 'ended' || !record.gameId) {
      throw new Error(`QC_GAME_TIMEOUT:${record?.status ?? 'missing'}`);
    }
    let review = await application.reviewPipeline.get(record.gameId);
    while (review?.status !== 'completed' && Date.now() < deadline) {
      await sleep(20);
      review = await application.reviewPipeline.get(record.gameId);
    }
    if (!review || (review.status !== 'completed' && review.status !== 'disabled')) {
      throw new Error(`QC_REVIEW_TIMEOUT:${review?.status ?? 'missing'}`);
    }
    const stored = await application.eventStore.read(`game:${record.gameId}`);
    const players = record.session?.state.players ?? record.players;
    const header = [
      `# 身份表 ${players.map((player) => `${player.name}:${roleName(player.role)}`).join(', ')}`,
      '# 规则 屠边（神职全死或平民全死 → 狼胜；狼全死 → 好人胜）',
      '# source template',
    ];
    const output = [...header, ...renderQcLines(stored, players)];
    const outputPath = path.join(process.cwd(), 'qc_events.txt');
    fs.writeFileSync(outputPath, `${output.join('\n')}\n`, 'utf8');
    const winner = record.session?.state.gameState.winner;
    console.log(`[test-drive] 已生成 ${outputPath}`);
    console.log(`[test-drive] 玩家数=${players.length}，V3 composition root，对局结果=${winner ?? 'draw'}，事件行数=${output.length}`);
  } finally {
    await application.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error('[test-drive] 运行失败:', error);
  process.exitCode = 1;
});
