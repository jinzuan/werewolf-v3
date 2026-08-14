import assert from 'node:assert/strict';
import test from 'node:test';
import type { Player } from '../../shared/types';
import {
  buildAIPrompt,
  parseAIOutput,
  PromptAIProvider,
  RepeatPolicy,
  speechSimilarity,
} from '../ai';
import type { AIRequestContext } from '../ai/types';

const players: Player[] = [
  {
    id: 'p1',
    roomId: 'room-1',
    name: '小明',
    isAI: true,
    role: 'villager',
    isAlive: true,
    isHost: false,
    order: 1,
  },
  {
    id: 'p2',
    roomId: 'room-1',
    name: '小红',
    isAI: true,
    role: null,
    isAlive: true,
    isHost: false,
    order: 2,
  },
  {
    id: 'p3',
    roomId: 'room-1',
    name: '大壮',
    isAI: true,
    role: null,
    isAlive: true,
    isHost: false,
    order: 3,
  },
];

const context = (
  overrides: Partial<AIRequestContext> = {},
): AIRequestContext => ({
  roomId: 'room-1',
  gameId: 'game-1',
  playerId: 'p1',
  role: 'villager',
  phase: 'day',
  stage: 'speech',
  stageRevision: 4,
  callId: 'call-1',
  players,
  allowedCommandTypes: ['game.speak'],
  promptContext: {
    dayNumber: 1,
    roundNumber: 1,
    publicEvents: ['小红公开解释了改票原因。'],
    publicSpeeches: ['小红：我改票是因为她的时间线有矛盾。'],
    ownPreviousSpeeches: ['我上一轮怀疑小红，因为她改票没有解释。'],
    privateRoleFacts: [],
    legalActions: ['speak'],
    legalTargets: [],
    abstainAllowed: false,
  },
  ...overrides,
});

test('builder assembles system, role, projected facts, and output contract', () => {
  const prompt = buildAIPrompt(context());

  assert.match(prompt.system, /你的角色是 平民/);
  assert.match(prompt.system, /服务端提供的规则/);
  assert.match(prompt.user, /小红公开解释了改票原因/);
  assert.match(prompt.user, /小红：我改票是因为她的时间线有矛盾/);
  assert.match(prompt.user, /"action":"speak"/);
  assert.doesNotMatch(`${prompt.system}\n${prompt.user}`, /\{\{|\}\}/);
});

test('builder injects experience and selects the correct voting task', () => {
  const basePromptContext = {
    ...context().promptContext,
    legalActions: ['vote'] as const,
    legalTargets: [{ id: 'p2', name: '小红' }],
    abstainAllowed: true,
    experience: 'EXPERIENCE_SENTINEL',
  };
  const normal = buildAIPrompt(
    context({
      phase: 'voting',
      stage: 'voting',
      allowedCommandTypes: ['game.vote'],
      promptContext: { ...basePromptContext, isRepeatVote: false },
    }),
  );
  assert.match(normal.system, /EXPERIENCE_SENTINEL/);
  assert.doesNotMatch(normal.user, /当前是服务端确认的平票重投/);

  const repeat = buildAIPrompt(
    context({
      phase: 'voting',
      stage: 'voting',
      allowedCommandTypes: ['game.vote'],
      promptContext: {
        ...basePromptContext,
        isRepeatVote: true,
        repeatVoteVoterStatus: '有投票权',
      },
    }),
  );
  assert.match(repeat.user, /当前是服务端确认的平票重投/);
});

test('parser returns structured vote and rejects an illegal target', () => {
  const voteContext = context({
    allowedCommandTypes: ['game.vote'],
    promptContext: {
      ...context().promptContext,
      legalActions: ['vote'],
      legalTargets: [
        { id: 'p2', name: '小红' },
        { id: 'p3', name: '大壮' },
      ],
      abstainAllowed: false,
    },
  });
  const parsed = parseAIOutput(
    '{"action":"vote","target":"小红","reason":"她的改票解释和前一轮承诺冲突"}',
    voteContext,
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.command, {
      type: 'game.vote',
      payload: {
        targetId: 'p2',
        reason: '她的改票解释和前一轮承诺冲突',
      },
    });
  }

  const invalid = parseAIOutput(
    '{"action":"vote","target":"不存在","reason":"没有依据"}',
    voteContext,
  );
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.code, 'TARGET_NOT_ALLOWED');
});

test('repeat policy detects same-scene near duplicates and allows a new scene', () => {
  const policy = new RepeatPolicy();
  const scene = {
    gameId: 'game-1',
    playerId: 'p1',
    phase: 'day',
    stage: 'speech',
  };
  policy.record(scene, '小红改票没有解释，所以我怀疑小红。');
  const repeated = policy.inspect(scene, '小红改票未解释，我还是怀疑小红。');
  assert.equal(repeated.repeated, true);
  assert.ok(repeated.similarity >= 0.72);
  assert.match(repeated.guidance, /换一种说法/);
  assert.ok(speechSimilarity('完全不同的证据', '小红改票没有解释') < 0.82);
  assert.equal(
    policy.inspect({ ...scene, stage: 'voting' }, '小红改票未解释，我还是怀疑小红。').repeated,
    false,
  );
});

test('rules are injected by the server and expose V3 wolf options', () => {
  const prompt = buildAIPrompt(
    context({
      role: 'wolf',
      phase: 'night',
      stage: 'wolf_vote',
      allowedCommandTypes: ['game.wolf_vote'],
      promptContext: {
        dayNumber: 1,
        roundNumber: 1,
        legalActions: ['wolf_vote'],
        legalTargets: [
          { id: 'p1', name: '小明' },
          { id: 'p2', name: '小红' },
        ],
        wolfTeammates: ['小明'],
        abstainAllowed: false,
      },
    }),
  );
  assert.match(prompt.system, /可自刀或选择狼队友：是/);
  assert.match(prompt.system, /允许空刀：是/);
  assert.match(prompt.user, /小明（p1）、小红（p2）/);
  assert.doesNotMatch(prompt.system, /{{roles\.werewolf/);
});

test('prompt provider retries one repeated speech before returning one command', async () => {
  const outputs = [
    '{"action":"speak","content":"小红改票没有解释，所以我怀疑小红。"}',
    '{"action":"speak","content":"小红改票没有解释，所以我怀疑小红。"}',
    '{"action":"speak","content":"先追问小红为什么改票，再决定是否改变归票。"}',
  ];
  let calls = 0;
  const provider = new PromptAIProvider({
    async complete() {
      const output = outputs[calls];
      calls += 1;
      return output;
    },
  });
  const first = await provider.suggest(context());
  assert.equal(first.command.type, 'game.speak');
  const second = await provider.suggest(context({ callId: 'call-2' }));
  assert.equal(second.command.type, 'game.speak');
  assert.equal(calls, 3);
});
