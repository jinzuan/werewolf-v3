import type { AIProvider, AISuggestion } from './types';

export class DeterministicAIProvider implements AIProvider {
  async suggest(
    context: Parameters<AIProvider['suggest']>[0],
  ): Promise<AISuggestion> {
    const actor = context.players.find(
      (player) => player.id === context.playerId,
    );
    const alive = context.players.filter((player) => player.isAlive);
    const target = alive.find((player) => player.id !== context.playerId);
    const rotatingTarget =
      alive[context.stageRevision % Math.max(1, alive.length)] ?? actor;
    if (!actor) throw new Error('AI actor not found.');

    const allowed = new Set(context.allowedCommandTypes);
    if (allowed.has('game.night_action') && actor.role === 'guardian') {
      return {
        command: {
          type: 'game.night_action' as const,
          payload: {
            playerId: actor.id,
            action: 'guard' as const,
            targetId: rotatingTarget.id,
          },
        },
        reason: 'deterministic self guard',
      };
    }
    if (allowed.has('game.night_action') && actor.role === 'seer' && target) {
      return {
        command: {
          type: 'game.night_action' as const,
          payload: {
            playerId: actor.id,
            action: 'check' as const,
            targetId: target.id,
          },
        },
        reason: 'deterministic first legal target',
      };
    }
    if (allowed.has('game.wolf_vote')) {
      const wolfTarget =
        alive.find((player) => player.role !== 'wolf') ?? target ?? actor;
      return {
        command: {
          type: 'game.wolf_vote' as const,
          payload: { targetId: wolfTarget.id },
        },
        reason: 'deterministic first legal target',
      };
    }
    if (allowed.has('game.skip_speech')) {
      return {
        command: { type: 'game.skip_speech' as const, payload: {} },
        reason: 'deterministic speech skip',
      };
    }
    if (allowed.has('game.vote')) {
      return {
        command: {
          type: 'game.vote' as const,
          payload: { targetId: target?.id ?? null },
        },
        reason: 'deterministic first legal vote',
      };
    }
    if (allowed.has('game.hunter_shoot')) {
      return {
        command: {
          type: 'game.hunter_shoot' as const,
          payload: { targetId: target?.id ?? null },
        },
        reason: 'deterministic hunter target',
      };
    }
    return {
      command: {
        type: 'game.skip_night' as const,
        payload: {
          action:
            actor.role === 'guardian'
              ? ('guard' as const)
              : actor.role === 'seer'
                ? ('check' as const)
                : ('heal' as const),
        },
      },
      reason: 'deterministic night skip',
    };
  }
}
