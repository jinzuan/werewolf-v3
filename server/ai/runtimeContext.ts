import type { DomainEvent } from '../../shared/events';
import type { GameAction, Player, Role } from '../../shared/types';
import type { AILegalTarget, AIPromptContext } from './types';

export interface AIRuntimeContextInput {
  actorId: string;
  role: Role;
  phase: string;
  stage: string | null;
  dayNumber: number;
  roundNumber: number;
  players: Player[];
  visibleEvents: DomainEvent[];
  allowedActions: GameAction[];
  voteCandidates?: string[];
  guardianLastTarget?: string | null;
  witchHasHealPotion?: boolean;
  witchHasPoisonPotion?: boolean;
  hunterShotAvailable?: boolean;
  wolfVoteRound?: number;
  lastWordsRound?: number;
  lastWordsRoundsRemaining?: number;
  firstLastWords?: string;
  experience?: string;
}

const playerName = (players: readonly Player[], id: unknown): string =>
  typeof id === 'string'
    ? players.find((player) => player.id === id)?.name ?? id
    : '未知玩家';

const payload = (event: DomainEvent): Record<string, unknown> =>
  event.payload as Record<string, unknown>;

const publicSpeechEvents = (
  events: readonly DomainEvent[],
): DomainEvent[] => events.filter((event) => event.eventType === 'day.speech');

const publicVoteEvents = (
  events: readonly DomainEvent[],
): DomainEvent[] => events.filter((event) => event.eventType === 'day.vote_cast');

const latestOvernightPublicEvent = (
  input: AIRuntimeContextInput,
): string[] => {
  const event = [...input.visibleEvents]
    .reverse()
    .find(
      (candidate) =>
        candidate.visibility === 'public_timeline' &&
        candidate.eventType === 'night.resolved',
    );
  if (!event) return [];

  const item = payload(event);
  const deaths = Array.isArray(item.deaths)
    ? item.deaths.filter((id): id is string => typeof id === 'string')
    : [];
  if (deaths.length > 0) {
    return [`夜间公开死亡：${deaths.map((id) => playerName(input.players, id)).join('、')}`];
  }
  if (item.peacefulNight === true) return ['平安夜'];
  return ['夜间公开死亡信息缺失（服务端事件异常）'];
};

const eventDay = (
  _event: DomainEvent,
  item: Record<string, unknown>,
  fallback: number,
): number =>
  typeof item.day === 'number' ? item.day : fallback;

const voteHistoryFromPayload = (
  value: unknown,
  players: readonly Player[],
): string[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((ballot) => {
    if (!ballot || typeof ballot !== 'object') return [];
    const item = ballot as Record<string, unknown>;
    const voter = playerName(players, item.voterId);
    const target =
      typeof item.targetId === 'string'
        ? playerName(players, item.targetId)
        : '弃票';
    return [`${voter} 投票给 ${target}`];
  });
};

/**
 * Final words are a separate AI call. Keep a durable, public death bulletin
 * in that call instead of asking the model to reconstruct it from the latest
 * overnight line. `night.resolved.payload.deaths` is the same atomic source
 * used by the day prompt fix in fb1ba64.
 */
const visibleDeathHistory = (
  input: AIRuntimeContextInput,
): string[] => {
  const history: string[] = [];
  for (const event of input.visibleEvents) {
    if (event.visibility !== 'public_timeline') continue;
    const item = payload(event);
    const day = eventDay(event, item, input.dayNumber);
    if (event.eventType === 'night.resolved') {
      const deaths = Array.isArray(item.deaths)
        ? item.deaths.filter((id): id is string => typeof id === 'string')
        : [];
      if (deaths.length > 0) {
        history.push(
          `第${day}晚公开死亡：${deaths
            .map((id) => playerName(input.players, id))
            .join('、')}`
        );
      } else if (item.peacefulNight === true) {
        history.push(`第${day}晚：平安夜`);
      } else {
        history.push(`第${day}晚：系统未提供死亡列表（不等同于平安夜）`);
      }
    } else if (event.eventType === 'day.exiled') {
      history.push(
        `第${day}天公开放逐：${playerName(input.players, item.playerId)}`,
      );
    } else if (event.eventType === 'hunter.shot') {
      history.push(
        `第${day}天公开死亡（猎人开枪）：${playerName(input.players, item.targetId)}`,
      );
    }
  }
  return history.length > 0
    ? history
    : ['系统未提供可见死亡公告历史（不等同于平安夜）'];
};

const visibleActionHistory = (
  input: AIRuntimeContextInput,
): string[] => {
  const history: string[] = [];
  for (const event of input.visibleEvents) {
    const item = payload(event);
    const day = eventDay(event, item, input.dayNumber);
    if (event.eventType === 'day.exiled' || event.eventType === 'day.no_exile') {
      const votes = voteHistoryFromPayload(item.voteHistory, input.players);
      if (votes.length > 0) history.push(`第${day}天已公开票型：${votes.join('、')}`);
      continue;
    }
    if (event.visibility === 'wolf_private' && event.eventType === 'wolf.kill_locked') {
      history.push(`第${day}晚狼队已锁定刀口：${playerName(input.players, item.targetId)}`);
      continue;
    }
    if (event.visibility !== 'role_private') continue;
    switch (event.eventType) {
      case 'seer.result':
        history.push(
          `第${day}晚你的查验：${playerName(input.players, item.targetId)}，结果${
            item.alignment === 'wolf' ? '狼人' : '好人'
          }`,
        );
        break;
      case 'witch.completed':
        history.push(
          `第${day}晚你的用药：${String(item.action ?? '系统未提供动作')}，目标${
            typeof item.targetId === 'string'
              ? playerName(input.players, item.targetId)
              : '无'
          }`,
        );
        break;
      case 'guardian.completed':
        history.push(`第${day}晚你的守护：${playerName(input.players, item.targetId)}`);
        break;
      case 'witch.kill_notice':
        history.push(
          item.hasKillNotice === true && typeof item.killTargetId === 'string'
            ? `第${day}晚服务端刀口通知：${playerName(input.players, item.killTargetId)}`
            : `第${day}晚系统未提供刀口通知（不等同于你不知道发生了什么）`,
        );
        break;
      case 'night.skipped':
        history.push(`第${day}晚你跳过了${String(item.action ?? '夜间行动')}`);
        break;
      default:
        break;
    }
  }

  if (history.length > 0) return history;
  switch (input.role) {
    case 'seer':
      return ['系统未提供你的查验记录（不等同于“我不知道”；本次没有可核对的服务端记录）'];
    case 'witch':
      return ['系统未提供你的用药记录（不等同于“我不知道”；本次没有可核对的服务端记录）'];
    case 'guardian':
      return ['系统未提供你的守护记录（不等同于“我不知道”；本次没有可核对的服务端记录）'];
    default:
      return ['你不知道其他角色的私有行动；系统不会向你的视角提供这些记录'];
  }
};

const buildPrivateFacts = (
  input: AIRuntimeContextInput,
): {
  facts: string[];
  wolfPrivateChat: string[];
  guardianHistory: string[];
  seerCheckHistory: string[];
  witchKillNotice: string;
} => {
  const facts: string[] = [];
  const wolfPrivateChat: string[] = [];
  const guardianHistory: string[] = [];
  const seerCheckHistory: string[] = [];
  let witchKillNotice = '';

  for (const event of input.visibleEvents) {
    const item = payload(event);
    if (event.visibility === 'wolf_private') {
      if (event.eventType === 'wolf.message') {
        wolfPrivateChat.push(
          `${playerName(input.players, item.actorId ?? event.actorId)}：${String(item.content ?? '')}`,
        );
      } else if (event.eventType === 'wolf.kill_locked') {
        facts.push(`服务端已锁定狼刀目标：${playerName(input.players, item.targetId)}`);
      } else if (event.eventType === 'wolf.vote_cast') {
        facts.push('狼队一票已记录，具体他人票型以服务端公开或狼队私有投影为准。');
      }
      continue;
    }
    if (event.visibility !== 'role_private') continue;
    switch (event.eventType) {
      case 'guardian.completed':
        guardianHistory.push(`守护目标：${playerName(input.players, item.targetId)}`);
        facts.push(`你真实守护了：${playerName(input.players, item.targetId)}`);
        break;
      case 'seer.result':
        seerCheckHistory.push(
          `查验 ${playerName(input.players, item.targetId)}：${item.alignment === 'wolf' ? '狼人' : '好人'}`,
        );
        facts.push(
          `服务端查验结果：${playerName(input.players, item.targetId)} 是 ${
            item.alignment === 'wolf' ? '狼人' : '好人'
          }`,
        );
        break;
      case 'witch.kill_notice':
        if (item.hasKillNotice === true && typeof item.killTargetId === 'string') {
          witchKillNotice = `服务端刀口通知：${playerName(input.players, item.killTargetId)}`;
          facts.push(witchKillNotice);
        } else {
          witchKillNotice = '无刀口通知；不得推断通知缺失原因';
        }
        break;
      case 'witch.completed':
        facts.push(
          `你本夜真实用药：${String(item.action ?? '无')}，目标 ${
            typeof item.targetId === 'string'
              ? playerName(input.players, item.targetId)
              : '无'
          }`,
        );
        break;
      case 'hunter.entitled':
        facts.push('服务端已授予本次开枪资格。');
        break;
      case 'night.skipped':
        facts.push(`你已跳过本夜 ${String(item.action ?? '行动')}。`);
        break;
      default:
        break;
    }
  }

  return {
    facts,
    wolfPrivateChat,
    guardianHistory,
    seerCheckHistory,
    witchKillNotice,
  };
};

const buildPublicFacts = (
  input: AIRuntimeContextInput,
): Pick<AIPromptContext, 'publicSpeeches' | 'currentRoundSpeeches' | 'publicVoteHistory' | 'ownPreviousSpeeches'> => {
  const speechEvents = publicSpeechEvents(input.visibleEvents);
  const publicSpeeches = speechEvents.map((event) => {
    const item = payload(event);
    return `${playerName(input.players, item.actorId ?? event.actorId)}：${String(item.content ?? '')}`;
  });
  const publicVoteHistory = publicVoteEvents(input.visibleEvents).flatMap((event) => {
    const item = payload(event);
    if (typeof item.targetId !== 'string') return [];
    return [`${playerName(input.players, item.actorId ?? event.actorId)} 投票给 ${playerName(input.players, item.targetId)}`];
  });
  for (const event of input.visibleEvents) {
    if (event.visibility !== 'public_timeline') continue;
    if (event.eventType !== 'day.exiled' && event.eventType !== 'day.no_exile') continue;
    publicVoteHistory.push(...voteHistoryFromPayload(payload(event).voteHistory, input.players));
  }
  const ownPreviousSpeeches = speechEvents
    .filter((event) => {
      const item = payload(event);
      return item.actorId === input.actorId || event.actorId === input.actorId;
    })
    .map((event) => String(payload(event).content ?? ''));
  return {
    publicSpeeches,
    currentRoundSpeeches: publicSpeeches,
    publicVoteHistory,
    ownPreviousSpeeches,
  };
};

export const legalTargetsForAI = (
  players: readonly Player[],
  actorId: string,
  allowedActions: readonly GameAction[],
  voteCandidates: readonly string[] = [],
  guardianLastTarget?: string | null,
): AILegalTarget[] => {
  const alive = players.filter((player) => player.isAlive);
  if (allowedActions.includes('wolf_vote')) {
    return alive.map(({ id, name }) => ({ id, name }));
  }
  if (allowedActions.includes('vote')) {
    const candidates =
      voteCandidates.length > 0
        ? alive.filter((player) => voteCandidates.includes(player.id))
        : alive;
    return candidates
      .filter((player) => player.id !== actorId)
      .map(({ id, name }) => ({ id, name }));
  }
  if (allowedActions.includes('guard')) {
    return alive
      .filter((player) => player.id !== guardianLastTarget)
      .map(({ id, name }) => ({ id, name }));
  }
  if (
    allowedActions.includes('check') ||
    allowedActions.includes('poison') ||
    allowedActions.includes('hunter_shoot')
  ) {
    return alive
      .filter((player) => player.id !== actorId)
      .map(({ id, name }) => ({ id, name }));
  }
  return [];
};

export const buildAIRuntimeContext = (
  input: AIRuntimeContextInput,
): AIPromptContext => {
  const privateFacts = buildPrivateFacts(input);
  const publicFacts = buildPublicFacts(input);
  const wolfTeammates =
    input.role === 'wolf'
      ? input.players
          .filter((player) => player.role === 'wolf' && player.isAlive)
          .map((player) => player.name)
      : undefined;
  return {
    dayNumber: input.dayNumber,
    roundNumber: input.roundNumber,
    visibleEvents: input.visibleEvents,
    privateRoleFacts: privateFacts.facts,
    wolfPrivateChat: privateFacts.wolfPrivateChat,
    guardianHistory: privateFacts.guardianHistory,
    seerCheckHistory: privateFacts.seerCheckHistory,
    witchKillNotice: privateFacts.witchKillNotice,
    witchPotionState:
      input.role === 'witch'
        ? `解药${input.witchHasHealPotion ? '可用' : '已用完'}；毒药${
            input.witchHasPoisonPotion ? '可用' : '已用完'
          }`
        : undefined,
    hunterShotAvailable: input.hunterShotAvailable,
    wolfTeammates,
    wolfVoteRound: input.wolfVoteRound,
    publicSpeeches: publicFacts.publicSpeeches,
    currentRoundSpeeches: publicFacts.currentRoundSpeeches,
    publicVoteHistory: publicFacts.publicVoteHistory,
    ownPreviousSpeeches: publicFacts.ownPreviousSpeeches,
    overnightPublicEvents: latestOvernightPublicEvent(input),
    lastWordsRound: input.lastWordsRound,
    lastWordsRoundsRemaining: input.lastWordsRoundsRemaining,
    firstLastWords:
      input.firstLastWords ??
      input.visibleEvents
        .filter((event) => {
          const item = payload(event);
          return (
            event.eventType === 'day.speech' &&
            item.lastWords === true &&
            (item.actorId === input.actorId || event.actorId === input.actorId)
          );
        })
        .map((event) => String(payload(event).content ?? ''))
        .find(Boolean),
    experience: input.experience,
    lastWordsVisibleDeathHistory: visibleDeathHistory(input),
    lastWordsVisibleActionHistory: visibleActionHistory(input),
    legalActions: [...input.allowedActions],
    legalTargets: legalTargetsForAI(
      input.players,
      input.actorId,
      input.allowedActions,
      input.voteCandidates,
      input.guardianLastTarget,
    ),
    abstainAllowed: input.allowedActions.includes('abstain'),
    repeatVoteVoterStatus:
      input.stage === 'voting'
        ? input.allowedActions.includes('vote')
          ? '有投票权'
          : '无投票权'
        : undefined,
    isRepeatVote:
      input.stage === 'voting' && (input.voteCandidates?.length ?? 0) > 0,
  };
};
