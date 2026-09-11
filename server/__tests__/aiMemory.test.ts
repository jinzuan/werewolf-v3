import assert from 'node:assert/strict';
import test from 'node:test';
import type { DomainEvent } from '../../shared/events';
import { buildAIPrompt } from '../ai/promptBuilder';
import {
  formatAIMemoryBoard,
  initializeAIMemoryBoards,
  memorySeatCount,
  recommendedWolfTarget,
  updateAIMemoryBoards,
} from '../ai/memory';
import { createPlayers } from './fixtures';

const event = (
  sequence: number,
  eventType: DomainEvent['eventType'],
  payload: Record<string, unknown>,
  visibility: DomainEvent['visibility'] = 'public_timeline',
  audienceIds?: string[],
): DomainEvent => ({
  eventId: `memory-${sequence}`,
  roomId: 'room-memory',
  gameId: 'game-memory',
  sequence,
  occurredAt: sequence,
  phase: eventType.startsWith('wolf.') ? 'night' : 'day',
  stage: eventType.startsWith('wolf.') ? 'wolf_discussion' : 'speech',
  eventType,
  payload,
  visibility,
  ...(audienceIds ? { audienceIds } : {}),
  correlationId: `memory-${sequence}`,
  schemaVersion: 1,
});

test('memory boards initialize a complete evidence/target node for every seat', () => {
  const players = createPlayers();
  const boards = initializeAIMemoryBoards(players);
  assert.equal(Object.keys(boards).length, players.length);
  for (const player of players) {
    assert.equal(memorySeatCount(boards[player.id]), players.length);
  }
});

test('good memory tracks completed speech opportunities without pre-labelling the whole table silent', () => {
  const players = createPlayers();
  players[0].name = '甲';
  players[1].name = '乙';
  const board = initializeAIMemoryBoards(players)['guardian-1'];
  const updated = updateAIMemoryBoards(board ? { 'guardian-1': board } : {}, [
    event(1, 'day.started', { day: 1 }),
    event(2, 'day.speech', { actorId: 'guardian-1', content: '我怀疑乙可疑，先记为不足' }),
    event(3, 'day.speech', { actorId: 'guardian-1', content: '我相信乙是好人，我改判' }),
    event(4, 'day.speech', { actorId: 'villager-9', content: '我怀疑乙，票型和回避值得警惕' }),
    event(5, 'day.speech_skipped', { actorId: 'villager-10' }),
    event(6, 'day.speech_skipped', { actorId: 'villager-10' }),
  ], players);
  const result = updated['guardian-1'];
  assert.equal(result.kind, 'good_evidence');
  if (result.kind !== 'good_evidence') return;
  assert.equal(Object.keys(result.nodes).length, players.length);
  assert.equal(result.nodes['guardian-1'].behavior.contradictionCount, 1);
  assert.equal(result.nodes['villager-9'].behavior.speechOpportunities, 1);
  assert.equal(result.nodes['villager-9'].behavior.silenceRate, 0);
  assert.equal(result.nodes['villager-10'].behavior.speechOpportunities, 2);
  assert.equal(result.nodes['villager-10'].behavior.silenceRate, 1);
  assert.ok(result.nodes['villager-10'].evidence.some((item) => /持续低发言/u.test(item.summary)));
  assert.match(formatAIMemoryBoard(result, players), /不足|存疑/u);
});

test('wolf memory ranks exposed information and leadership above silent targets', () => {
  const players = createPlayers();
  const wolfId = 'wolf-3';
  const board = initializeAIMemoryBoards(players)[wolfId];
  const updated = updateAIMemoryBoards({ [wolfId]: board }, [
    event(1, 'day.started', { day: 1 }),
    event(2, 'day.speech', {
      actorId: 'villager-9',
      content: '我认为 seer-2 是预言家，查验和归票信息很强，今天明确投 wolf-3',
    }),
    event(3, 'wolf.message', {
      actorId: wolfId,
      content: '白天先跟着票型施压，晚上处理最能带队的信息位。',
      round: 1,
    }, 'wolf_private', [wolfId]),
  ], players);
  const result = updated[wolfId];
  assert.equal(result.kind, 'wolf_plan');
  if (result.kind !== 'wolf_plan') return;
  assert.equal(recommendedWolfTarget(result, ['seer-2', 'villager-10']), 'seer-2');
  assert.match(formatAIMemoryBoard(result, players), /昼间计划/u);
  assert.match(formatAIMemoryBoard(result, players), /夜间记录/u);
});

test('wolf memory labels the previous kill as history and keeps the new high-threat focus authoritative', () => {
  const players = createPlayers();
  const wolf = players.find((player) => player.role === 'wolf')!;
  const seer = players.find((player) => player.role === 'seer')!;
  const low = players.find((player) => player.role === 'villager')!;
  const board = initializeAIMemoryBoards(players)[wolf.id];
  const updated = updateAIMemoryBoards({ [wolf.id]: board }, [
    event(1, 'wolf.kill_locked', { targetId: low.id }, 'wolf_private', [wolf.id]),
    event(2, 'day.speech', {
      actorId: seer.id,
      content: `我是预言家，查验${wolf.name}是狼人，今天出他。`,
    }),
  ], players)[wolf.id];
  assert.equal(updated.kind, 'wolf_plan');
  if (updated.kind !== 'wolf_plan') return;
  assert.equal(updated.focusTargetId, seer.id);
  const rendered = formatAIMemoryBoard(updated, players);
  assert.match(rendered, /历史刀口/u);
  assert.match(rendered, /旧刀口.*不是本夜锁定/u);
  assert.match(rendered, new RegExp(`当前焦点：${seer.name}`, 'u'));
});

test('prompt injection keeps the board private to the requesting role', () => {
  const players = createPlayers();
  const wolf = players.find((player) => player.role === 'wolf')!;
  const board = initializeAIMemoryBoards(players)[wolf.id];
  const prompt = buildAIPrompt({
    roomId: 'room-memory',
    gameId: 'game-memory',
    playerId: wolf.id,
    role: 'wolf',
    phase: 'night',
    stage: 'wolf_vote',
    stageRevision: 1,
    callId: 'memory-prompt',
    players,
    allowedActions: ['wolf_vote'],
    allowedCommandTypes: ['game.wolf_vote'],
    promptContext: {
      memoryBoard: board,
      legalActions: ['wolf_vote'],
      legalTargets: players.map(({ id, name }) => ({ id, name })),
    },
  });
  assert.match(prompt.user, /我的狼人攻杀板/u);
  assert.match(prompt.user, /不优先刀沉默低威胁位/u);
});
