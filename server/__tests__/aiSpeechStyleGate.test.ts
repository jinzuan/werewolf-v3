import assert from 'node:assert/strict';
import test from 'node:test';
import { SERVER_AI_DEFAULTS, type ServerAIConfig } from '../ai/config';
import { DeterministicAIProvider } from '../ai/deterministicProvider';
import { HttpAIProvider } from '../ai/httpProvider';
import { PromptAIProvider } from '../ai/promptProvider';
import {
  inspectSpeechStyle,
  type SpeechStyleGateContext,
  type SpeechStyleIssue,
} from '../ai/speechStyleGate';
import type { AIRequestContext } from '../ai/types';
import { createPlayers } from './fixtures';

const players = createPlayers();

const gateContext = (
  overrides: Partial<SpeechStyleGateContext> = {},
): SpeechStyleGateContext => ({
  commandType: 'game.speak',
  role: 'villager',
  phase: 'day',
  stage: 'speech',
  players,
  ...overrides,
});

const speechContext = (
  overrides: Partial<AIRequestContext> = {},
): AIRequestContext => ({
  roomId: 'room-style',
  gameId: 'game-style',
  playerId: players[0].id,
  role: 'villager',
  phase: 'day',
  stage: 'speech',
  stageRevision: 1,
  callId: 'style-call',
  players,
  allowedActions: ['speak', 'skip_speech'],
  allowedCommandTypes: ['game.speak', 'game.skip_speech'],
  promptContext: { legalActions: ['speak', 'skip_speech'] },
  ...overrides,
});

const providerConfig = (): ServerAIConfig => {
  const config = structuredClone(SERVER_AI_DEFAULTS);
  config.apiType = 'local';
  config.local = {
    ...config.local,
    apiUrl: 'https://provider.test/v1/chat/completions',
    model: 'style-test-model',
  };
  return config;
};

const response = (content: string): Response => new Response(
  JSON.stringify({ choices: [{ message: { content } }] }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

test('speech style gate identifies the reported template-heavy examples', () => {
  const cases: Array<[string, SpeechStyleIssue]> = [
    ['这不是简单的怀疑，而是完整逻辑链条……', 'PSEUDO_CONTRAST'],
    ['当前关键缺口仍在金钻的解释。', 'ADJUDICATION_TONE'],
    ['首先看发言，其次看票型，最后看身份。', 'MECHANICAL_ENUMERATION'],
    ['金钻这句——我先记着——但摸鱼王——也得回答。', 'EXCESSIVE_DASH'],
    ['别担心我会一直陪着你。', 'CUSTOMER_SERVICE_TONE'],
  ];

  for (const [speech, issue] of cases) {
    const result = inspectSpeechStyle(speech, gateContext());
    assert.equal(result.ok, false, speech);
    assert.ok(result.issues.includes(issue), speech);
    assert.match(result.rewriteInstruction, /保留原立场.*2-3 句.*不要解释/u);
  }
});

test('natural table talk, legal timelines, check results, and player names pass', () => {
  for (const speech of [
    '我先放着，金钻还没说首夜验谁。',
    '平安夜只能说明昨晚没人出局，和谁是真预言家没直接关系。',
    '第一晚查金钻是好人，第二晚查摸鱼王是狼人。',
    '首先报第一晚查金钻好人，其次报第二晚查摸鱼王狼人，最后说第三晚查好运来好人。',
    '金钻先发言，摸鱼王随后改票，我想问好运来为什么跟票。',
  ]) {
    assert.deepEqual(inspectSpeechStyle(speech, gateContext()), {
      ok: true,
      issues: [],
      rewriteInstruction: '',
    }, speech);
  }
});

test('known player names are not mistaken for style vocabulary', () => {
  assert.equal(inspectSpeechStyle(
    '底层逻辑还没发言，我想先听他怎么解释改票。',
    gateContext({ players: [{ name: '底层逻辑' }] }),
  ).ok, true);
});

test('a real correction is allowed while an invented pseudo-contrast is rejected', () => {
  const context = gateContext({
    promptContext: {
      currentRoundSpeeches: ['金钻：平安夜就是预言家验到好人。'],
    },
  });
  assert.equal(
    inspectSpeechStyle('这不是验到好人，而是只能说明昨晚没人出局。', context).ok,
    true,
  );
  assert.equal(
    inspectSpeechStyle('这不是普通问题，而是底层逻辑。', gateContext()).ok,
    false,
  );
});

test('empty agreement and direct restatement are rejected without scanning player text as output', () => {
  assert.ok(inspectSpeechStyle('对，我也这么想。', gateContext()).issues.includes('EMPTY_ECHO'));
  const context = gateContext({
    promptContext: { currentRoundSpeeches: ['金钻：摸鱼王还没交代为什么改票。'] },
  });
  assert.ok(
    inspectSpeechStyle('摸鱼王还没交代为什么改票。', context).issues.includes('EMPTY_ECHO'),
  );
  assert.equal(
    inspectSpeechStyle('金钻刚说底层逻辑很重要，我只问摸鱼王为什么改票。', gateContext()).ok,
    false,
    'only the generated output is screened; quoted industrial wording can still make that output unsuitable',
  );
});

test('private-fact screening is conservative and respects the wolf channel boundary', () => {
  const claim = '我昨晚在狼聊里听到金钻说要刀摸鱼王。';
  assert.ok(
    inspectSpeechStyle(claim, gateContext()).issues.includes('UNVERIFIABLE_PRIVATE_FACT'),
  );
  assert.equal(
    inspectSpeechStyle(claim, gateContext({
      commandType: 'game.wolf_speak',
      role: 'wolf',
      phase: 'night',
      stage: 'wolf_discussion',
    })).ok,
    true,
  );
  assert.equal(
    inspectSpeechStyle('我怀疑狼队昨晚商量过要保金钻。', gateContext()).ok,
    true,
  );
});

test('answered seer account cannot be erased into “no answer”, while disbelief remains legal', () => {
  const answered = [
    '某玩家：昨天我验了另一位，他是好人，我没验到狼。我猫着很正常，没验到狼第一天就跳出来不是作死？要不是有人说验我是狼，我怎么可能冒头？',
  ];
  const context = gateContext({
    promptContext: { currentRoundSpeeches: answered },
  });

  const erased = inspectSpeechStyle(
    '你只解释了为什么被逼才跳，没回答验人链本身。',
    context,
  );
  assert.ok(erased.issues.includes('ANSWER_ERASURE'));
  assert.match(erased.rewriteInstruction, /先承认已回应.*真实性存疑/u);

  assert.deepEqual(
    inspectSpeechStyle(
      '你解释了为什么现在才跳，这点我听到了。验人的真假我暂时还不能确认，先看后面的对跳和票型。',
      context,
    ),
    { ok: true, issues: [], rewriteInstruction: '' },
  );
  assert.equal(
    inspectSpeechStyle('我不太相信这份验人结果，先看后面的票型。', context).ok,
    true,
  );
});

test('first-night blind checks cannot be challenged for retrospective motive', () => {
  const rejected = inspectSpeechStyle(
    '你没说为什么第一晚验他，这个理由先交代清楚。',
    gateContext(),
  );
  assert.ok(rejected.issues.includes('RETROSPECTIVE_FIRST_CHECK_MOTIVE'));
  assert.match(rejected.rewriteInstruction, /第一晚盲选.*事后动机/u);
  assert.equal(
    inspectSpeechStyle('第一晚的验人结果我不太信，但先看对跳和票型。', gateContext()).ok,
    true,
  );
});

test('normal persona-level voice differences pass the common style gate', () => {
  for (const speech of [
    '这点我先保留，如果他后面改票再看。',
    '我先怀疑金钻，他为什么临时改票？',
    '金钻已经解释改票原因了，我听到了，但票型还不能证明他说的是真的。',
    '这改口有点快啊，我先记着，后面看他投谁。',
  ]) {
    assert.equal(inspectSpeechStyle(speech, gateContext()).ok, true, speech);
  }
});

test('a useful speech may report status or reserve judgment without naming anyone', () => {
  assert.deepEqual(
    inspectSpeechStyle(
      '目前没有新增信息，我先保留判断，继续听后面的公开发言。',
      gateContext({
        promptContext: {
          currentRoundSpeeches: [],
          newInformationSinceLastTurn: [],
        },
      }),
    ),
    { ok: true, issues: [], rewriteInstruction: '' },
  );
});

test('score shorthand requires a named player and a concrete public reason', () => {
  const named = players[0].name;
  for (const speech of [
    '这点加分。',
    '因为他态度很好，所以这点加分。',
    `${named}这点加分。`,
  ]) {
    const result = inspectSpeechStyle(speech, gateContext());
    assert.ok(result.issues.includes('VAGUE_SCORE_SHORTHAND'), speech);
    assert.match(result.rewriteInstruction, /明确对象.*公开事实/u);
  }

  for (const speech of [
    `${named}上一轮公开承诺投${players[1].name}，实际票型也一致，这点给${named}加分。`,
    `${named}刚才改票却没有解释原因，这个具体行为让我给${named}减分。`,
  ]) {
    assert.equal(inspectSpeechStyle(speech, gateContext()).ok, true, speech);
  }
});

test('repeated binary, forced-name, revision-condition and independence pressure is stopped without new evidence', () => {
  const cases = [
    ['你必须二选一。', '现在还是二选一，你只能选一个。'],
    ['请点一个最可疑对象。', '你必须点名一个最可疑对象。'],
    ['说清你的改判条件。', '你的改判条件到底是什么？'],
    ['你没有独立判断。', '你还是没有自己的判断。'],
  ];

  for (const [prior, current] of cases) {
    const result = inspectSpeechStyle(current, gateContext({
      promptContext: {
        currentRoundSpeeches: [prior],
        newInformationSinceLastTurn: [],
      },
    }));
    assert.ok(result.issues.includes('LOOPED_PRESSURE_PATTERN'), current);
    assert.match(result.rewriteInstruction, /不再要求二选一.*强迫点名/u);
  }
});

test('prompt provider rewrites style once and reparses the corrected action', async () => {
  const outputs = [
    JSON.stringify({ action: 'speak', content: '当前关键缺口仍在金钻。' }),
    JSON.stringify({ action: 'speak', content: '金钻还没解释改票，我想先听他回答。' }),
  ];
  const prompts: string[] = [];
  const provider = new PromptAIProvider({
    complete: async (prompt) => {
      prompts.push(`${prompt.system}\n${prompt.user}`);
      return outputs.shift() ?? '';
    },
  });

  const result = await provider.suggest(speechContext());

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /保留原立场.*2-3 句桌上聊天/u);
  assert.deepEqual(result.command, {
    type: 'game.speak',
    payload: { content: '金钻还没解释改票，我想先听他回答。' },
  });
  assert.equal(result.providerMeta?.retryCount, 1);
});

test('style correction is attempted at most once', async () => {
  let calls = 0;
  const provider = new PromptAIProvider({
    complete: async () => {
      calls += 1;
      return JSON.stringify({ action: 'speak', content: '首先听， 其次看，最后再说。' });
    },
  });

  await assert.rejects(() => provider.suggest(speechContext()), /AI_SPEECH_STYLE/u);
  assert.equal(calls, 2);
});

test('HTTP provider uses the same single style correction path', async () => {
  const outputs = [
    JSON.stringify({ action: 'speak', content: '别担心我会一直陪着你。' }),
    JSON.stringify({ action: 'speak', content: '摸鱼王这句有点怪，我想问他为什么改票。' }),
  ];
  const requests: string[] = [];
  const provider = new HttpAIProvider(providerConfig(), {
    fetch: async (_input, init) => {
      requests.push(String(init?.body));
      return response(outputs.shift() ?? '');
    },
    maxRetries: 0,
  });

  const result = await provider.suggest(speechContext());

  assert.equal(requests.length, 2);
  assert.match(requests[1], /保留原立场.*2-3 句桌上聊天/u);
  assert.equal(result.command.type, 'game.speak');
  assert.equal(result.providerMeta?.retryCount, 1);
});

test('wolf_speak is screened, but injected wolf chat history is not treated as generated output', async () => {
  const outputs = [
    JSON.stringify({ action: 'wolf_speak', content: '这不是刀口，而是最优解。' }),
    JSON.stringify({ action: 'wolf_speak', content: '我更想刀金钻，他白天留的信息最多。' }),
  ];
  let calls = 0;
  const provider = new PromptAIProvider({
    complete: async () => {
      calls += 1;
      return outputs.shift() ?? '';
    },
  });
  const result = await provider.suggest(speechContext({
    role: 'wolf',
    phase: 'night',
    stage: 'wolf_discussion',
    allowedActions: ['wolf_speak'],
    allowedCommandTypes: ['game.wolf_speak'],
    promptContext: {
      legalActions: ['wolf_speak'],
      wolfPrivateChat: ['金钻：先把底层逻辑形成闭环。'],
    },
  }));

  assert.equal(calls, 2);
  assert.equal(result.command.type, 'game.wolf_speak');

  let cleanCalls = 0;
  const cleanProvider = new PromptAIProvider({
    complete: async () => {
      cleanCalls += 1;
      return JSON.stringify({ action: 'wolf_speak', content: '我先看金钻，他白天像在找神。' });
    },
  });
  await cleanProvider.suggest(speechContext({
    role: 'wolf',
    phase: 'night',
    stage: 'wolf_discussion',
    allowedActions: ['wolf_speak'],
    allowedCommandTypes: ['game.wolf_speak'],
    promptContext: {
      legalActions: ['wolf_speak'],
      wolfPrivateChat: ['摸鱼王：首先赋能，其次闭环，最后找抓手。'],
    },
  }));
  assert.equal(cleanCalls, 1);
});

test('vote, night JSON, skip, and deterministic clean speech are unaffected', async () => {
  const voteProvider = new PromptAIProvider({
    complete: async () => JSON.stringify({
      action: 'vote',
      target: players[1].name,
      reason: '首先看发言，其次看票型，最后我投他。',
    }),
  });
  const vote = await voteProvider.suggest(speechContext({
    allowedActions: ['vote'],
    allowedCommandTypes: ['game.vote'],
    promptContext: {
      legalActions: ['vote'],
      legalTargets: [{ id: players[1].id, name: players[1].name }],
    },
  }));
  assert.equal(vote.command.type, 'game.vote');

  const skipProvider = new PromptAIProvider({
    complete: async () => JSON.stringify({ action: 'skip_speech' }),
  });
  assert.equal((await skipProvider.suggest(speechContext())).command.type, 'game.skip_speech');

  const guardian = players.find((player) => player.role === 'guardian')!;
  const target = players.find((player) => player.id !== guardian.id)!;
  const nightProvider = new PromptAIProvider({
    complete: async () => JSON.stringify({ action: 'guard', target: target.name }),
  });
  assert.equal((await nightProvider.suggest(speechContext({
    playerId: guardian.id,
    role: 'guardian',
    phase: 'night',
    stage: 'guard_seer',
    allowedActions: ['guard'],
    allowedCommandTypes: ['game.night_action'],
    promptContext: {
      legalActions: ['guard'],
      legalTargets: [{ id: target.id, name: target.name }],
    },
  }))).command.type, 'game.night_action');

  const deterministic = await new DeterministicAIProvider().suggest(speechContext({
    allowedActions: ['speak'],
    allowedCommandTypes: ['game.speak'],
  }));
  assert.equal(deterministic.command.type, 'game.speak');
  if (deterministic.command.type === 'game.speak') {
    assert.equal(inspectSpeechStyle(deterministic.command.payload.content, gateContext()).ok, true);
  }
});
