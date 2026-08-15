import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolve } from 'node:path';
import { RoomEngine, type EngineAIAdapter } from '../engine';
import type { Player } from '../../shared/types';
import type { ArchiveRecord } from '../../shared/protocol';

const adapter = (): EngineAIAdapter => ({
  source: 'real_ai',
  resetExperienceCache: () => {},
  resetSpeechRepeatCache: () => {},
  callAIApi: async (...args: unknown[]) => {
    const players = args[3] as Player[];
    const phase = args[5] as string;
    if (phase === '狼人讨论') {
      const target = players.find((player) => player.role !== 'wolf');
      return target ? `建议{${target.name}}作为今晚刀口。` : '跳过';
    }
    if (phase === '复盘') return '只基于本局可验证事件复盘，下一局按新证据更新判断。';
    return '我会结合公开票型和时间线继续判断。';
  },
  generateAIVoteDecision: async (...args: unknown[]) => {
    const players = args[3] as Player[];
    const playerName = args[2] as string;
    const target = players.find((player) => player.isAlive && player.name !== playerName);
    return { targetId: target?.id ?? 'skip', reason: '按公开票型判断。' };
  },
  generateAIThought: async (...args: unknown[]) => {
    const role = args[1] as string;
    const players = args[3] as Player[];
    const playerName = args[2] as string;
    if (role === 'witch') return '用药: 不用';
    return players.find((player) => player.isAlive && player.name !== playerName)?.id ?? '';
  },
});

const waitUntil = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('legacy engine records AI source and wolf action timeline at the write boundary', async () => {
  const engine = new RoomEngine({
    roomName: 'legacy log test',
    maxPlayers: 4,
    auto: true,
    reviewEnabled: true,
    noArchive: true,
    aiAdapter: adapter(),
    hub: { broadcastRoom: () => {}, destroyRoom: () => {} },
  });
  engine.fillAIPlayers(4);
  engine.autoStartIfNeeded();

  await waitUntil(() => {
    const types = new Set(engine.getTimelineEvents().map((event) => event.eventType));
    return types.has('wolf.message') && types.has('wolf.vote_cast') && types.has('wolf.kill_locked');
  });
  engine.destroy();

  const timeline = engine.getTimelineEvents();
  assert.ok(timeline.some((event) => event.eventType === 'wolf.message' && event.source === 'real_ai'));
  assert.ok(timeline.some((event) => event.eventType === 'wolf.vote_cast' && event.source === 'real_ai'));
  assert.ok(timeline.some((event) => event.eventType === 'wolf.kill_locked' && event.source === 'real_ai'));
  assert.ok(engine.wolfChat.some((message) => message.source === 'real_ai'));
  assert.ok(engine.wolfChat.every((message) => !message.content.includes('[mock]')));
});

test('test-drive keeps source metadata out of speech text and enables archive review', () => {
  const source = readFileSync(resolve(process.cwd(), 'test-drive.ts'), 'utf8');
  assert.doesNotMatch(source, /MOCK_MARKER|\[mock\]/);
  assert.match(source, /reviewEnabled:\s*true/);
  assert.match(source, /noArchive:\s*false/);
});

test('test-drive last words forwards the engine ledger through the shared AI path', () => {
  const source = readFileSync(resolve(process.cwd(), 'test-drive.ts'), 'utf8');
  const lastWordsBranch = source.match(/if \(gamePhase === '遗言'\) \{([\s\S]*?)\n {6}\}/)?.[1] || '';
  assert.match(lastWordsBranch, /ai\.callAIApi/);
  assert.match(lastWordsBranch, /messagesIn/);
  assert.match(lastWordsBranch, /_gameHistory/);
});

test('QC output is produced from the archive callback and its canonical game log', () => {
  const source = readFileSync(resolve(process.cwd(), 'test-drive.ts'), 'utf8');
  assert.match(source, /onArchive:\s*\(record\)\s*=>/);
  assert.match(source, /archivedRecord\.gameLogEvents/);
  assert.doesNotMatch(source, /const out = \[\.\.\.header, \.\.\.events\]/);
});

test('archive callback and engine log expose the same complete final event source', async () => {
  const archives: ArchiveRecord[] = [];
  const engine = new RoomEngine({
    roomName: 'canonical log test',
    maxPlayers: 4,
    auto: true,
    reviewEnabled: true,
    noArchive: true,
    aiAdapter: adapter(),
    hub: {
      broadcastRoom: () => {},
      destroyRoom: () => {},
      onArchive: (record) => archives.push(record),
    },
  });
  engine.fillAIPlayers(4);
  engine.autoStartIfNeeded();

  await waitUntil(() => archives.length > 0, 12_000);
  engine.destroy();

  assert.equal(archives.length, 1);
  assert.deepEqual(
    archives[0].gameLogEvents?.map((event) => event.line),
    engine.getGameLogEvents().map((event) => event.line),
  );
  assert.match(archives[0].gameLogEvents?.at(-1)?.line || '', /游戏结束/);
});

test('legacy exile enters last words before a vote can finish the game', async () => {
  const engine = new RoomEngine({
    roomName: 'legacy exile last words test',
    maxPlayers: 4,
    reviewEnabled: false,
    noArchive: true,
    aiAdapter: adapter(),
    hub: { broadcastRoom: () => {}, destroyRoom: () => {} },
  });
  engine.fillAIPlayers(4);
  (engine as unknown as { beginRoles: () => void }).beginRoles();
  const wolf = engine.players.find((player) => player.role === 'wolf');
  assert.ok(wolf);
  engine.game!.phase = 'vote';

  await (engine as unknown as {
    applyVoteResult: (targetId: string) => Promise<void>;
  }).applyVoteResult(wolf.id);

  assert.equal(engine.winnerTeam, 'good');
  assert.ok(
    engine.messages.some(
      (message) => message.playerId === wolf.id && message.type === 'public',
    ),
  );
  assert.match(
    engine.getGameLogEvents().find((event) => event.line.includes(`${wolf.name} 遗言`))?.line || '',
    new RegExp(`${wolf.name} 遗言`),
  );
});
