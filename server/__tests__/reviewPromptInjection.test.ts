import assert from 'node:assert/strict';
import test from 'node:test';
import type { Player } from '../../shared/types';
import { buildAIPrompt } from '../ai/promptBuilder';
import { buildAIRuntimeContext } from '../ai/runtimeContext';
import { InMemoryInsightStore } from '../review/insightStore';

test('server insight store is injected into the next V3 AI prompt as historical context', async () => {
  const store = new InMemoryInsightStore();
  await store.add({
    id: 'insight-1', role: 'seer', text: '第1晚查验结果应及时与第1天公开票型对齐。',
    evidenceEventIds: ['event-1'], gameId: 'old-game', createdAt: 1, schemaVersion: 1,
  });
  const players: Player[] = [{
    id: 'seer', roomId: 'room-prompt', name: '预言家', isAI: true, role: 'seer',
    isAlive: true, isHost: false, order: 1,
  }];
  const runtime = buildAIRuntimeContext({
    actorId: 'seer', role: 'seer', phase: 'voting', stage: 'voting', dayNumber: 1,
    roundNumber: 1, players, visibleEvents: [], allowedActions: ['vote'],
    experience: await store.getPromptReference('seer'),
  });
  const promptContext = {
    ...runtime,
    publicEvents: [],
    publicSpeeches: [],
    currentRoundSpeeches: [],
    ownPreviousSpeeches: [],
    publicVoteHistory: [],
    phaseTask: '根据服务端允许的动作完成当前投票。',
    legalActions: ['vote'],
    legalTargets: [{ id: 'seer', name: '预言家' }],
    abstainAllowed: false,
  };
  const prompt = buildAIPrompt({
    roomId: 'room-prompt', gameId: 'new-game', playerId: 'seer', role: 'seer',
    phase: 'voting', stage: 'voting', stageRevision: 1, callId: 'prompt-1',
    players, allowedCommandTypes: ['game.vote'], promptContext,
  });
  assert.match(prompt.system, /历史经验，非本局事实/);
  assert.match(prompt.system, /第1晚查验结果应及时与第1天公开票型对齐/);
});
