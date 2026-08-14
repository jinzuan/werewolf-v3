import type { DomainEvent, EventVisibility } from '../../shared/events';
import type {
  GameAction,
  GameState,
  NightStage,
  Role,
} from '../../shared/types';

export const ROLE_LABELS: Record<Role, string> = {
  wolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  villager: '村民',
  guardian: '守卫',
};

export const VISIBILITY_LABELS: Record<EventVisibility, string> = {
  public_timeline: '公开时间线',
  role_private: '角色私密',
  wolf_private: '狼人私密',
  spectator_omniscient: '全知观战',
};

export const ACTION_LABELS: Record<GameAction, string> = {
  guard: '守护',
  check: '查验',
  wolf_speak: '狼聊',
  wolf_vote: '狼人投票',
  heal: '使用解药',
  poison: '使用毒药',
  skip_night: '跳过夜间行动',
  speak: '发言',
  skip_speech: '跳过发言',
  vote: '投票',
  abstain: '弃票',
  hunter_shoot: '猎人开枪',
  skip_hunter_shot: '不开枪',
};

const NIGHT_STAGE_LABELS: Record<NightStage, string> = {
  guard_seer: '守卫与预言家',
  wolf_discussion: '狼人讨论',
  wolf_vote: '狼人投票',
  witch: '女巫行动',
  resolve: '夜间结算',
};

export const phaseLabel = (state: GameState | null): string => {
  if (!state) return '等待数据';
  if (state.phase === 'night' && state.nightStage) {
    return `第 ${state.day} 夜 · ${NIGHT_STAGE_LABELS[state.nightStage]}`;
  }
  const labels: Record<GameState['phase'], string> = {
    waiting: '等待开局',
    roleSelect: '身份确认',
    night: '夜间',
    day: `第 ${state.day} 天 · 发言`,
    vote: `第 ${state.day} 天 · 投票`,
    voting: `第 ${state.day} 天 · 投票`,
    hunterShoot: '猎人开枪',
    lastWords: '遗言',
    ended: '对局结束',
  };
  return labels[state.phase];
};

const playerId = (payload: Record<string, unknown>, key: string): string | null =>
  typeof payload[key] === 'string' ? payload[key] as string : null;

export const describeEvent = (
  event: DomainEvent,
  playerName: (id: string | null) => string,
): string => {
  const payload = event.payload;
  switch (event.eventType) {
    case 'game.started':
      return `对局开始，第 ${String(payload.day ?? 1)} 夜进入守卫与预言家阶段`;
    case 'wolf.message':
      return `${playerName(playerId(payload, 'actorId'))}：${String(payload.content ?? '')}`;
    case 'wolf.vote_cast':
      return `${playerName(playerId(payload, 'actorId'))} 已提交狼人投票`;
    case 'wolf.kill_locked':
      return `狼人已锁定 ${playerName(playerId(payload, 'targetId'))}`;
    case 'guardian.completed':
      return `守卫选择守护 ${playerName(playerId(payload, 'targetId'))}`;
    case 'seer.result':
      return `查验 ${playerName(playerId(payload, 'targetId'))}：${payload.alignment === 'wolf' ? '狼人' : '好人'}`;
    case 'witch.kill_notice':
      return `女巫收到刀口：${playerName(playerId(payload, 'killTargetId'))}`;
    case 'witch.completed':
      return `女巫完成${payload.action === 'heal' ? '解药' : '毒药'}行动：${playerName(playerId(payload, 'targetId'))}`;
    case 'night.skipped':
      return `${playerName(playerId(payload, 'actorId'))} 跳过当前夜间行动`;
    case 'night.resolved': {
      if (payload.peacefulNight === true) return '天亮了，昨夜是平安夜';
      const deaths = Array.isArray(payload.deaths)
        ? payload.deaths.map((id) => playerName(typeof id === 'string' ? id : null)).join('、')
        : '未知';
      return `天亮了，昨夜出局：${deaths}`;
    }
    case 'night.resolution_detail':
      return '夜间结算明细已生成';
    default:
      return event.eventType.replace(/\./g, ' / ');
  }
};

export const formatEventTime = (timestamp: number): string =>
  new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(timestamp);
