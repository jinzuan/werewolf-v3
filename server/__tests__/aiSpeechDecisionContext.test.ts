import assert from 'node:assert/strict';
import test from 'node:test';
import { DeterministicAIProvider } from '../ai/deterministicProvider';
import { AI_PERSONA_CATALOG } from '../ai/persona';
import {
  buildSpeechDecisionContext,
  formatSpeechDecisionContext,
  shouldPreferSpeechSkip,
} from '../ai/speechDecisionContext';
import type { AIRequestContext } from '../ai/types';
import { createPlayers } from './fixtures';

const players = createPlayers('room-speech-decision');

const context = (
  overrides: Partial<AIRequestContext> = {},
): AIRequestContext => ({
  roomId: 'room-speech-decision',
  gameId: 'game-speech-decision',
  playerId: players[0].id,
  role: players[0].role,
  phase: 'day',
  stage: 'speech',
  stageRevision: 3,
  callId: 'speech-decision-call',
  players,
  allowedActions: ['speak', 'skip_speech'],
  allowedCommandTypes: ['game.speak', 'game.skip_speech'],
  promptContext: {
    legalActions: ['speak', 'skip_speech'],
    phaseTask: '报告事实、回应或保留；有需要时才推进归票。',
    newInformationSinceLastTurn: [],
  },
  ...overrides,
});

test('public speech decisions treat naming a suspect as optional', () => {
  const request = context();
  const decision = buildSpeechDecisionContext(request, request.promptContext ?? {});

  assert.ok(decision.allowedMoves.includes('报告当前已知信息'));
  assert.ok(decision.allowedMoves.includes('回应别人对自己的质疑'));
  assert.ok(decision.allowedMoves.includes('认可一个具体判断'));
  assert.ok(decision.allowedMoves.includes('保留观察'));
  assert.ok(decision.allowedMoves.includes('指认一个人'));
  assert.ok(decision.allowedMoves.includes('跳过发言'));
  assert.equal(decision.preferNoContentExit, true);

  const prompt = formatSpeechDecisionContext(request, request.promptContext ?? {});
  assert.match(prompt, /“指认一个人”不是必填项/u);
  assert.match(prompt, /没有点名仍是合法有效发言/u);
  assert.match(prompt, /首轮信息报告尤其不强迫报狼坑/u);
});

test('no-content exit depends on current novelty or being addressed, not stale claims', () => {
  const staleClaim = context({
    promptContext: {
      legalActions: ['speak', 'skip_speech'],
      newInformationSinceLastTurn: [],
      publicRoleClaims: ['第二天有人公开声称预言家'],
      publicSeerClaims: ['历史验人记录仍可见'],
    },
  });
  assert.equal(shouldPreferSpeechSkip(staleClaim), true);

  const actorName = players[0].name;
  const addressed = context({
    promptContext: {
      legalActions: ['speak', 'skip_speech'],
      newInformationSinceLastTurn: [],
      currentRoundSpeeches: [`${players[1].name}：${actorName}，请回应你刚才的票。`],
    },
  });
  assert.equal(shouldPreferSpeechSkip(addressed), false);
  const addressedDecision = buildSpeechDecisionContext(
    addressed,
    addressed.promptContext ?? {},
  );
  assert.equal(addressedDecision.requiresResponse, true);
  assert.ok(addressedDecision.responseTriggers.length > 0);

  const newRoleConflict = context({
    promptContext: {
      legalActions: ['speak', 'skip_speech'],
      newInformationSinceLastTurn: [`${players[1].name}的新发言：我才是预言家，前面那个是对跳。`],
    },
  });
  assert.equal(shouldPreferSpeechSkip(newRoleConflict), false);
  assert.equal(
    buildSpeechDecisionContext(newRoleConflict, newRoleConflict.promptContext ?? {}).requiresResponse,
    true,
  );
});

test('AI speech metrics keep skips to idle turns and answer response triggers', async () => {
  const provider = new DeterministicAIProvider();
  const actorName = players[0].name;
  const cases = [
    context(),
    context({
      promptContext: {
        legalActions: ['speak', 'skip_speech'],
        newInformationSinceLastTurn: [`${players[1].name}的新发言：${actorName}，你为什么改票？`],
        currentRoundSpeeches: [`${players[1].name}：${actorName}，你为什么改票？`],
      },
    }),
    context({
      promptContext: {
        legalActions: ['speak', 'skip_speech'],
        newInformationSinceLastTurn: [`${players[2].name}新跳预言家，与前面形成对跳。`],
      },
    }),
  ];
  const commands = await Promise.all(cases.map((item) => provider.suggest(item)));
  const speakCount = commands.filter((item) => item.command.type === 'game.speak').length;
  const skipCount = commands.filter((item) => item.command.type === 'game.skip_speech').length;
  const triggered = cases.filter((item) =>
    buildSpeechDecisionContext(item, item.promptContext ?? {}).requiresResponse,
  );
  const triggeredResponses = await Promise.all(triggered.map((item) => provider.suggest(item)));

  assert.deepEqual({ speakCount, skipCount }, { speakCount: 2, skipCount: 1 });
  assert.equal(
    triggeredResponses.filter((item) => item.command.type === 'game.speak').length /
      triggeredResponses.length,
    1,
  );
});

test('persona and experience remain subordinate to visible facts and legal actions', () => {
  const request = context({
    promptContext: {
      legalActions: ['speak', 'skip_speech'],
      legalTargets: [],
      privateRoleFacts: ['服务端可见事实：当前没有查验结果'],
      newInformationSinceLastTurn: [],
      personaVoiceProfile: AI_PERSONA_CATALOG[5],
      experience: '经验候选：强势推进时可以考虑点名，但本局事实不足时不得执行。',
    },
  });
  const decision = buildSpeechDecisionContext(request, request.promptContext ?? {});
  const prompt = formatSpeechDecisionContext(request, request.promptContext ?? {});

  assert.deepEqual(decision.legalActions, ['speak', 'skip_speech']);
  assert.equal(decision.preferNoContentExit, true);
  assert.match(prompt, /服务端可见事实：当前没有查验结果/u);
  assert.match(prompt, /只改变表达与关注点，不改变事实、权限或动作/u);
  assert.match(prompt, /只用于提出行为候选，不强制执行套路/u);
  assert.match(prompt, /与当前事实冲突时忽略/u);
});

test('deterministic speech fallback uses a legal skip when nothing changed', async () => {
  const provider = new DeterministicAIProvider();
  const skipped = await provider.suggest(context());
  assert.equal(skipped.command.type, 'game.skip_speech');

  const speechOnly = await provider.suggest(context({
    allowedActions: ['speak'],
    allowedCommandTypes: ['game.speak'],
    promptContext: { legalActions: ['speak'], newInformationSinceLastTurn: [] },
  }));
  assert.equal(speechOnly.command.type, 'game.speak');

  const lastWords = await provider.suggest(context({
    phase: 'lastWords',
    stage: 'last_words',
  }));
  assert.deepEqual(lastWords.command, {
    type: 'game.skip_speech',
    payload: { reason: '没有新的信息可补充' },
  });
});
