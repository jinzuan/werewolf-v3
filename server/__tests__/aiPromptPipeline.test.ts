import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMAIN_EVENT_SCHEMA_VERSION, type DomainEvent } from '../../shared/events';
import type { Player } from '../../shared/types';
import {
  buildAIPrompt,
  buildAIRuntimeContext,
  parseAIOutput,
  PromptAIProvider,
  RepeatPolicy,
  speechSimilarity,
} from '../ai';
import type { AIRequestContext } from '../ai/types';
import { buildLegacyAIPrompt, buildReviewContext } from '../../shared/aiClient';

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

const nightResolved = (
  payload: Record<string, unknown>,
): DomainEvent<'night.resolved'> => ({
  eventId: 'night-resolved-1',
  roomId: 'room-1',
  gameId: 'game-1',
  sequence: 10,
  occurredAt: 10,
  phase: 'day',
  stage: 'dawn',
  eventType: 'night.resolved',
  payload,
  visibility: 'public_timeline',
  correlationId: 'night-1',
  schemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
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

test('night death events survive prompt compression and only a true peaceful night says peaceful', () => {
  const dead = buildAIPrompt(
    context({
      promptContext: {
        ...context().promptContext,
        publicEvents: undefined,
        visibleEvents: [
          nightResolved({ peacefulNight: false, deaths: ['p2'] }),
        ],
      },
    }),
  );
  assert.match(dead.user, /夜间公开死亡：小红/);
  assert.doesNotMatch(dead.user, /平安夜/);

  const peaceful = buildAIPrompt(
    context({
      promptContext: {
        ...context().promptContext,
        publicEvents: undefined,
        visibleEvents: [nightResolved({ peacefulNight: true, deaths: [] })],
      },
    }),
  );
  assert.match(peaceful.user, /平安夜/);

  const inconsistent = buildAIPrompt(
    context({
      promptContext: {
        ...context().promptContext,
        publicEvents: undefined,
        visibleEvents: [nightResolved({ peacefulNight: false, deaths: [] })],
      },
    }),
  );
  assert.match(inconsistent.user, /夜间公开死亡信息缺失/);
  assert.doesNotMatch(inconsistent.user, /平安夜/);
});

test('last words end-to-end prompt carries projected death ledger, private actions, and locked votes', () => {
  const lastWordsPlayers = players.map((player) => ({
    ...player,
    role:
      player.id === 'p1' ? ('seer' as const) : player.id === 'p2' ? ('wolf' as const) : null,
    isAlive: player.id !== 'p1' && player.id !== 'p3',
  }));
  const visibleEvents: DomainEvent[] = [
    nightResolved({ day: 1, peacefulNight: false, deaths: ['p3'] }),
    {
      ...nightResolved({
        day: 2,
        playerId: 'p1',
        voteHistory: [
          { voterId: 'p2', targetId: 'p1' },
          { voterId: 'p3', targetId: 'p1' },
        ],
      }),
      eventType: 'day.exiled',
      phase: 'lastWords',
      stage: 'last_words',
      sequence: 20,
    },
    {
      ...nightResolved({
        day: 1,
        targetId: 'p2',
        alignment: 'wolf',
      }),
      eventType: 'seer.result',
      phase: 'lastWords',
      stage: 'last_words',
      visibility: 'role_private',
      audienceIds: ['p1'],
      sequence: 21,
    },
  ];
  const runtime = buildAIRuntimeContext({
    actorId: 'p1',
    role: 'seer',
    phase: 'lastWords',
    stage: 'last_words',
    dayNumber: 2,
    roundNumber: 1,
    players: lastWordsPlayers,
    visibleEvents,
    allowedActions: ['speak'],
    lastWordsRound: 1,
    lastWordsRoundsRemaining: 2,
  });
  const prompt = buildAIPrompt({
    ...context({
      playerId: 'p1',
      role: 'seer',
      phase: 'lastWords',
      stage: 'last_words',
      players: lastWordsPlayers,
      allowedCommandTypes: ['game.speak'],
      promptContext: runtime,
    }),
  });

  assert.match(prompt.user, /遗言可见死亡公告历史/);
  assert.match(prompt.user, /第1晚公开死亡：大壮/);
  assert.match(prompt.user, /第2天公开放逐：小明/);
  assert.match(prompt.user, /第1晚你的查验：小红，结果狼人/);
  assert.match(prompt.user, /第2天已公开票型：小红 投票给 小明、大壮 投票给 小明/);
  assert.match(prompt.user, /遗言第 1 轮，剩余 2 轮/);
  assert.doesNotMatch(prompt.user, /昨晚.*平安夜/);
});

test('last words distinguishes an invisible fact from a service record that was not injected', () => {
  const runtime = buildAIRuntimeContext({
    actorId: 'p1',
    role: 'seer',
    phase: 'lastWords',
    stage: 'last_words',
    dayNumber: 2,
    roundNumber: 1,
    players,
    visibleEvents: [nightResolved({ day: 1, peacefulNight: true, deaths: [] })],
    allowedActions: ['speak'],
  });
  const prompt = buildAIPrompt(
    context({
      phase: 'lastWords',
      stage: 'last_words',
      promptContext: runtime,
    }),
  );

  assert.match(prompt.user, /系统未提供你的查验记录/);
  assert.match(prompt.user, /不等同于“我不知道”/);
  assert.match(prompt.user, /第1晚：平安夜/);
});

test('last-words skip requires a reason in the prompt and parser', () => {
  const lastWordsContext = context({
    phase: 'lastWords',
    stage: 'last_words',
    allowedCommandTypes: ['game.speak', 'game.skip_speech'],
    promptContext: {
      ...context().promptContext,
      lastWordsRound: 2,
      lastWordsRoundsRemaining: 1,
      legalActions: ['speak', 'skip_speech'],
    },
  });
  const prompt = buildAIPrompt(lastWordsContext);
  assert.match(prompt.user, /skip_speech.*reason/);
  assert.match(prompt.user, /不得静默/);

  const withReason = parseAIOutput(
    '{"action":"skip_speech","reason":"懒得说"}',
    lastWordsContext,
  );
  assert.equal(withReason.ok, true);
  if (withReason.ok) {
    assert.deepEqual(withReason.command, {
      type: 'game.skip_speech',
      payload: { reason: '懒得说' },
    });
  }

  const withoutReason = parseAIOutput(
    '{"action":"skip_speech"}',
    lastWordsContext,
  );
  assert.equal(withoutReason.ok, false);
  if (!withoutReason.ok) assert.equal(withoutReason.code, 'REASON_REQUIRED');
});

test('legacy last words use the same death ledger and retain seer checks on dead targets', () => {
  const legacyPlayers = [
    { ...players[0], role: 'seer' as const, isAlive: false },
    { ...players[1], role: 'wolf' as const, isAlive: true },
    { ...players[2], role: 'villager' as const, isAlive: false },
  ];
  const prompt = buildLegacyAIPrompt({
    role: 'seer',
    playerName: '小明',
    players: legacyPlayers,
    messages: [],
    gamePhase: '遗言',
    day: 2,
    gameHistory: {
      nightResults: [
        { day: 1, checked: { target: '小红', result: '狼人' } },
      ],
      votes: { p2: 'p1' },
      deadPlayers: [
        { name: '小明', role: 'seer', day: 2, reason: '被投票出局' },
        { name: '大壮', role: 'villager', day: 1, reason: '狼刀' },
      ],
      playerKnowledge: {
        小红: {
          name: '小红',
          suspiciousLevel: 0,
          checkResults: [{ day: 1, result: '狼人' }],
          votes: [{ day: 2, target: '小明' }],
        },
      },
    },
  });

  assert.match(prompt.user, /遗言可见死亡公告历史/);
  assert.match(prompt.user, /大壮（第1晚 狼刀）/);
  assert.match(prompt.user, /小明（第2天 被投票出局）/);
  assert.match(prompt.user, /第1晚查验 小红：狼人/);
  assert.match(prompt.user, /第2天公开票型：小红投→小明/);
  assert.doesNotMatch(prompt.user, /昨晚（第1晚）之后.*平安夜/);
});

test('review prompt carries the complete timeline and per-player action ledger', () => {
  const prompt = buildReviewContext(
    {
      nightResults: [
        { day: 1, killed: '大壮', checked: { target: '小红', result: '狼人' } },
      ],
      votes: { p1: 'p2' },
      deadPlayers: [
        { name: '大壮', role: 'villager', day: 1, reason: '狼刀' },
      ],
      reviewTimeline: [
        { day: 1, phase: '夜间行动', event: '预言家查验 小红 → 狼人', actor: '小明', target: '小红' },
        { day: 1, phase: '公开投票', event: '小明 投→小红（理由：票型）', actor: '小明', target: '小红' },
      ],
    },
    players,
    [{
      id: 'message-1',
      roomId: 'room-1',
      playerId: 'p1',
      playerName: '小明',
      content: '我根据查验结果归票。',
      timestamp: new Date(0),
      type: 'public',
    }],
  );

  assert.match(prompt, /本局完整事件时间线/);
  assert.match(prompt, /小明.*小红/);
  assert.match(prompt, /逐人行动记录/);
  assert.match(prompt, /夜间结算记录/);
  assert.match(prompt, /我根据查验结果归票/);
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
