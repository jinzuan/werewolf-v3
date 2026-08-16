import type { AIProvider, AISuggestion } from './types';

export interface DeterministicAIProviderOptions {
  mode?: 'rules-degraded' | 'test-deterministic';
}

export class DeterministicAIProvider implements AIProvider {
  readonly mode: 'rules-degraded' | 'test-deterministic';

  constructor(options: DeterministicAIProviderOptions = {}) {
    this.mode = options.mode ?? 'test-deterministic';
  }

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
    if (allowed.has('game.confirm_role')) {
      return {
        command: { type: 'game.confirm_role', payload: {} },
        reason: 'deterministic role confirmation',
      };
    }
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
    if (allowed.has('game.wolf_speak')) {
      return {
        command: {
          type: 'game.wolf_speak' as const,
          payload: {
            content: `第${context.promptContext?.dayNumber ?? '?'}天仍有${alive.length}名玩家存活，先结合公开发言和投票变化继续判断。`,
          },
        },
        reason: 'rules-degraded contextual wolf discussion',
      };
    }
    if (allowed.has('game.speak')) {
      return {
        command: {
          type: 'game.speak' as const,
          payload: {
            content: `第${context.promptContext?.dayNumber ?? '?'}天当前有${alive.length}名玩家存活，我会结合已公开的信息继续观察并说明判断。`,
          },
        },
        reason: 'rules-degraded contextual speech',
      };
    }
    if (allowed.has('game.skip_speech')) {
      return {
        command: {
          type: 'game.skip_speech' as const,
          payload:
            context.phase === 'lastWords' || context.stage === 'last_words'
              ? { reason: '没有新的信息可补充' }
              : {},
        },
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
