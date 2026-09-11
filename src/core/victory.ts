import type {
  CorePlayer,
  VictoryContext,
  VictoryResult,
} from './types';

const GOD_ROLES = new Set(['seer', 'witch', 'hunter', 'guardian']);

export function evaluateVictory(
  players: readonly CorePlayer[],
  context: VictoryContext,
): VictoryResult {
  if (context.checkpoint !== 'after_atomic_resolution') {
    throw new Error('Victory may only be evaluated after atomic resolution.');
  }
  const alive = players.filter((player) => player.alive);
  const wolves = alive.filter((player) => player.role === 'wolf');
  const gods = alive.filter((player) => GOD_ROLES.has(player.role));
  const villagers = alive.filter((player) => player.role === 'villager');

  const goodCondition = wolves.length === 0;
  const wolfCondition = gods.length === 0 || villagers.length === 0;
  if (goodCondition && wolfCondition) {
    return { winner: 'draw', reason: 'simultaneous_conditions' };
  }
  if (goodCondition) return { winner: 'good', reason: 'all_werewolves_dead' };
  if (gods.length === 0) return { winner: 'wolf', reason: 'all_gods_dead' };
  if (villagers.length === 0) {
    return { winner: 'wolf', reason: 'all_villagers_dead' };
  }
  return { winner: null, reason: null };
}
