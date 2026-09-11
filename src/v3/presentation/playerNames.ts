import {
  fallbackAIName,
  isLegacyAIName,
} from '../../../shared/aiNames';

export interface DisplayPlayer {
  id: string;
  name: string;
  isAI: boolean;
  order: number;
}

export interface DisplayRosterMember {
  id: string;
  name: string;
}

/**
 * Resolve names from the authoritative game snapshot, with the room roster as
 * a second source for reconnect races and a deterministic repair for legacy
 * "电脑 01" values. New games always use the snapshot name directly.
 */
export const displayPlayerName = (
  player: DisplayPlayer,
  rosterName?: string,
): string => {
  if (!player.isAI) return player.name || rosterName || '未知目标';
  if (player.name && !isLegacyAIName(player.name)) return player.name;
  if (rosterName && !isLegacyAIName(rosterName)) return rosterName;
  return fallbackAIName(player.order);
};

export const createPlayerNameResolver = (
  players: readonly DisplayPlayer[],
  roster: readonly DisplayRosterMember[] = [],
): ((id: string | null) => string) => {
  const rosterNames = new Map(roster.map((member) => [member.id, member.name]));
  const byId = new Map(players.map((player) => [player.id, player]));
  return (id: string | null): string => {
    if (!id) return '未知目标';
    const player = byId.get(id);
    return player
      ? displayPlayerName(player, rosterNames.get(id))
      : rosterNames.get(id) || '未知目标';
  };
};
