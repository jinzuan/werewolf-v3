import assert from 'node:assert/strict';
import test from 'node:test';
import { DeterministicAIProvider } from '../ai/deterministicProvider';
import type { AIRequestContext } from '../ai/types';
import { InMemoryEventStore } from '../events/store';
import { InMemoryCredentialStore } from '../security/roomCredentialStore';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';
import { createPlayers } from './fixtures';

const context = (overrides: Partial<AIRequestContext> = {}): AIRequestContext => ({
  roomId: 'room-1',
  gameId: 'game-1',
  playerId: 'villager-9',
  role: 'villager',
  phase: 'day',
  stage: 'discussion',
  stageRevision: 3,
  callId: 'call-1',
  players: createPlayers(),
  allowedCommandTypes: ['game.speak'],
  allowedActions: ['speak'],
  promptContext: {
    dayNumber: 2,
    situationSummary: '上一轮公开投票集中在 wolf-1。',
  },
  ...overrides,
});

test('default rules-degraded AI emits contextual non-empty speech and wolf discussion', async () => {
  const provider = new DeterministicAIProvider({ mode: 'rules-degraded' });
  const speech = await provider.suggest(context());
  const wolfSpeech = await provider.suggest(context({
    playerId: 'wolf-3',
    role: 'wolf',
    allowedCommandTypes: ['game.wolf_speak'],
    allowedActions: ['wolf_speak'],
  }));

  assert.equal(provider.mode, 'rules-degraded');
  assert.equal(speech.command.type, 'game.speak');
  assert.equal(wolfSpeech.command.type, 'game.wolf_speak');
  assert.match(String(speech.command.payload.content), /第2天/);
  assert.match(String(wolfSpeech.command.payload.content), /12名玩家存活/);
  assert.ok(String(speech.command.payload.content).trim().length > 0);
  assert.ok(String(wolfSpeech.command.payload.content).trim().length > 0);
});

test('production RoomService cannot boot an implicit deterministic provider', () => {
  assert.throws(
    () => new RoomService(
      new InMemoryRoomRepository(),
      new InMemoryEventStore(),
      {
        environment: 'production',
        credentialStore: new InMemoryCredentialStore(),
      },
    ),
    (error: unknown) => error instanceof Error && error.message === 'AI_PROVIDER_REQUIRED',
  );
});
