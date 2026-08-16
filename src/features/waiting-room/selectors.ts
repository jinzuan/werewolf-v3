import type {
  AllowedRoomAction,
  RoomMemberViewV31,
  RoomViewV31,
  StartCheckItem,
} from '../../../shared/roomContract';

export const WAITING_ROOM_STATUSES = [
  'waiting',
  'ready_check',
  'starting',
] as const;

export type WaitingRoomStatus = (typeof WAITING_ROOM_STATUSES)[number];

export const WAITING_STATUS_LABELS: Record<RoomViewV31['status'], string> = {
  waiting: '等待入座',
  ready_check: '等待准备',
  starting: '正在开局',
  playing: '对局进行中',
  ended: '对局已结束',
};

export interface WaitingSeat {
  seatIndex: number;
  member: RoomMemberViewV31 | null;
}

export interface StartCheckCopy {
  label: string;
  reason: string;
  remedy: string;
  remedyAction?: Extract<AllowedRoomAction, 'invite' | 'update_config' | 'update_ai_config'>;
}

const numberParam = (
  item: StartCheckItem,
  key: string,
): number | undefined => {
  const value = item.params?.[key];
  return typeof value === 'number' ? value : undefined;
};

const numberParamFirst = (
  item: StartCheckItem,
  ...keys: string[]
): number | undefined => keys
  .map((key) => numberParam(item, key))
  .find((value): value is number => value !== undefined);

/** Room facts are the only source for seat occupancy. Empty seats have no member. */
export const selectPlayerSeats = (room: RoomViewV31): WaitingSeat[] => {
  const totalSeats = Math.max(0, room.config.maxPlayers);
  const bySeat = new Map<number, RoomMemberViewV31>();

  for (const member of room.members) {
    if (member.kind !== 'player' || member.seatIndex === null) continue;
    if (member.seatIndex >= 0 && member.seatIndex < totalSeats) {
      bySeat.set(member.seatIndex, member);
    }
  }

  return Array.from({ length: totalSeats }, (_, seatIndex) => ({
    seatIndex,
    member: bySeat.get(seatIndex) ?? null,
  }));
};

export const selectUnassignedPlayers = (
  room: RoomViewV31,
): RoomMemberViewV31[] =>
  room.members.filter(
    (member) =>
      member.kind === 'player' &&
      (member.seatIndex === null ||
        member.seatIndex < 0 ||
        member.seatIndex >= room.config.maxPlayers),
  );

export const selectSpectators = (
  room: RoomViewV31,
): RoomMemberViewV31[] =>
  room.members.filter((member) => member.kind === 'spectator');

export const isActionAllowed = (
  room: RoomViewV31,
  action: AllowedRoomAction,
): boolean => room.viewer.allowedRoomActions.includes(action);

export const isWaitingRoomStatus = (
  status: RoomViewV31['status'],
): status is WaitingRoomStatus =>
  (WAITING_ROOM_STATUSES as readonly string[]).includes(status);

export const checkLabel = (item: StartCheckItem): string => {
  switch (item.key) {
    case 'config_valid':
      return '房间设置可用';
    case 'role_count':
      return '角色总数与席位一致';
    case 'minimum_humans':
      return '真人达到最低人数';
    case 'all_humans_online':
      return '参与开局的真人均在线';
    case 'all_humans_ready':
      return '真人玩家全部准备';
    case 'ai_fill':
      return '电脑席位可以补齐';
    case 'ai_provider_config':
      return '电脑玩家配置可用';
    case 'ruleset_available':
      return '规则集仍然可用';
  }
};

/** Convert server check keys into safe, player-facing Chinese copy. */
export const startCheckCopy = (item: StartCheckItem): StartCheckCopy => {
  if (item.passed) {
    return {
      label: checkLabel(item),
      reason: '已满足',
      remedy: '',
    };
  }

  switch (item.key) {
    case 'config_valid':
      return {
        label: checkLabel(item),
        reason: '房间设置需要重新确认。',
        remedy: '查看房间设置',
        remedyAction: 'update_config',
      };
    case 'role_count': {
      const expected = numberParam(item, 'expected') ?? numberParam(item, 'required');
      const actual = numberParam(item, 'actual');
      const detail = expected !== undefined && actual !== undefined
        ? `当前为 ${actual} 个，需要 ${expected} 个。`
        : '角色数量与本局席位不一致。';
      return {
        label: checkLabel(item),
        reason: detail,
        remedy: '检查角色配置',
        remedyAction: 'update_config',
      };
    }
    case 'minimum_humans': {
      const required = numberParamFirst(item, 'required', 'minimum');
      const actual = numberParam(item, 'actual');
      const missing = required !== undefined && actual !== undefined
        ? Math.max(0, required - actual)
        : undefined;
      return {
        label: checkLabel(item),
        reason: missing !== undefined
          ? `还需要 ${missing} 名真人加入。`
          : '真人玩家还未达到最低开局人数。',
        remedy: '邀请玩家',
        remedyAction: 'invite',
      };
    }
    case 'all_humans_online':
      {
        const total = numberParam(item, 'total');
        const actual = numberParam(item, 'actual');
        const missing = total !== undefined && actual !== undefined
          ? Math.max(0, total - actual)
          : undefined;
        return {
          label: checkLabel(item),
          reason: missing !== undefined && missing > 0
            ? `还有 ${missing} 名真人暂时离线。`
            : '有真人玩家暂时离线，恢复连接后才能开始。',
          remedy: '查看离线席位',
        };
      }
    case 'all_humans_ready': {
      const required = numberParamFirst(item, 'required', 'total');
      const actual = numberParam(item, 'actual');
      const missing = required !== undefined && actual !== undefined
        ? Math.max(0, required - actual)
        : undefined;
      return {
        label: checkLabel(item),
        reason: missing !== undefined
          ? missing > 0 ? `还有 ${missing} 名真人玩家未准备。` : '仍有真人玩家未准备。'
          : '仍有真人玩家未准备。',
        remedy: '查看未准备席位',
      };
    }
    case 'ai_fill': {
      const expected = numberParamFirst(item, 'expected', 'required');
      const actual = numberParam(item, 'actual');
      const missing = numberParam(item, 'missing');
      const detail = missing !== undefined && missing > 0
        ? `还需要 ${missing} 个电脑席。`
        : expected !== undefined && actual !== undefined && actual > expected
          ? `当前有 ${actual} 个电脑席，最多需要 ${expected} 个。`
          : '电脑席位无法按当前房间设置补齐。';
      return {
        label: checkLabel(item),
        reason: detail,
        remedy: '查看房间设置',
        remedyAction: 'update_config',
      };
    }
    case 'ai_provider_config':
      return {
        label: checkLabel(item),
        reason: '电脑玩家配置或凭据不可用。',
        remedy: '修改电脑玩家设置',
        remedyAction: 'update_ai_config',
      };
    case 'ruleset_available':
      return {
        label: checkLabel(item),
        reason: '当前规则集暂不可用。',
        remedy: '查看房间设置',
        remedyAction: 'update_config',
      };
  }
};

/** A compact reason for disabled room actions, composed only from start checks. */
export const startCheckReason = (item: StartCheckItem): string => {
  const copy = startCheckCopy(item);
  return `${copy.label}：${copy.reason}`;
};

export const memberReadyLabel = (
  member: RoomMemberViewV31,
): string => {
  if (member.isAI) return '电脑 · 已就绪';
  if (!member.connected) return member.ready ? '离线 · 已准备' : '离线 · 未准备';
  return member.ready ? '在线 · 已准备' : '在线 · 未准备';
};

export const spectatorPresenceLabel = (member: RoomMemberViewV31): string =>
  member.connected ? '在线' : '离线';
