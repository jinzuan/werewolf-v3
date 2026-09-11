import type { DomainEvent, ProjectedSnapshot } from '../../../shared/events';
import type { Player, Role } from '../../../shared/types';

export interface MatchDeathRecord {
  playerId: string;
  name: string;
  role: Role | null;
  day: number;
  reason: string;
  sequence: number;
}

export interface MatchPlayerResult {
  id: string;
  name: string;
  role: Role | null;
  isAI: boolean;
  isAlive: boolean;
  order: number;
}

export type MatchWinner = 'wolf' | 'good' | 'draw' | null;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {};

const stringValue = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const numberValue = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const playerIdFrom = (value: unknown): string | null => {
  const item = record(value);
  return stringValue(value) ??
    stringValue(item.playerId) ??
    stringValue(item.targetId) ??
    stringValue(item.id);
};

const idsFromEvent = (event: DomainEvent): string[] => {
  const payload = record(event.payload);
  if (event.eventType === 'night.resolved') {
    return Array.isArray(payload.deaths)
      ? payload.deaths.map(playerIdFrom).filter((id): id is string => id !== null)
      : [];
  }
  if (event.eventType === 'day.exiled') {
    return [stringValue(payload.playerId)].filter((id): id is string => id !== null);
  }
  if (event.eventType === 'hunter.shot') {
    return [stringValue(payload.targetId)].filter((id): id is string => id !== null);
  }
  return [];
};

const deathReason = (event: DomainEvent): string => {
  switch (event.eventType) {
    case 'night.resolved': return '夜间结算出局';
    case 'day.exiled': return '投票出局';
    case 'hunter.shot': return '猎人开枪';
    default: return '对局结算';
  }
};

/** The winner is taken from authoritative state first, then the ended event. */
export const resultWinner = (
  snapshot: ProjectedSnapshot,
  events: readonly DomainEvent[],
): MatchWinner => {
  if (snapshot.gameState.winner === 'wolf' || snapshot.gameState.winner === 'good') {
    return snapshot.gameState.winner;
  }
  const ended = [...events].reverse().find((event) => event.eventType === 'game.ended');
  const winner = record(ended?.payload).winner;
  return winner === 'wolf' || winner === 'good' || winner === 'draw' ? winner : null;
};

/** Build a deduplicated death log from public events and the final player state. */
export const resultDeaths = (
  snapshot: ProjectedSnapshot,
  events: readonly DomainEvent[],
): MatchDeathRecord[] => {
  const players = new Map(snapshot.players.map((player) => [player.id, player]));
  const seen = new Set<string>();
  const deaths: MatchDeathRecord[] = [];
  let currentDay = 1;

  for (const event of events) {
    const payload = record(event.payload);
    if (
      event.eventType === 'game.started' ||
      event.eventType === 'day.started' ||
      event.eventType === 'night.started'
    ) {
      currentDay = numberValue(payload.day, currentDay);
    }
    for (const playerId of idsFromEvent(event)) {
      if (seen.has(playerId)) continue;
      const player = players.get(playerId);
      if (!player) continue;
      seen.add(playerId);
      deaths.push({
        playerId,
        name: player.name,
        role: player.role,
        day: numberValue(payload.day, currentDay),
        reason: deathReason(event),
        sequence: event.sequence,
      });
    }
  }

  // A refreshed result view may arrive with the final snapshot before its
  // event replay. Keep the result useful and authoritative in that window.
  for (const player of snapshot.players) {
    if (player.isAlive || seen.has(player.id)) continue;
    seen.add(player.id);
    deaths.push({
      playerId: player.id,
      name: player.name,
      role: player.role,
      day: snapshot.gameState.day,
      reason: '对局结算',
      sequence: Number.MAX_SAFE_INTEGER,
    });
  }

  return deaths.sort((left, right) => left.sequence - right.sequence);
};

export const resultPlayers = (
  snapshot: ProjectedSnapshot,
): MatchPlayerResult[] => snapshot.players
  .map((player: Player) => ({
    id: player.id,
    name: player.name,
    role: player.role,
    isAI: player.isAI,
    isAlive: player.isAlive,
    order: player.order,
  }))
  .sort((left, right) => left.order - right.order);

export const reviewEvents = (events: readonly DomainEvent[]): DomainEvent[] =>
  events
    .filter((event) => event.eventType !== 'game.state_updated')
    .sort((left, right) => left.sequence - right.sequence);
