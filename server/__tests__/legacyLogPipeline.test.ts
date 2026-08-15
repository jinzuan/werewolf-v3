import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolve } from 'node:path';
import { RoomEngine, type EngineAIAdapter } from '../engine';
import type { Player } from '../../shared/types';

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

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3_000;
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
