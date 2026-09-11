import type {
  Alignment,
  CorePlayer,
  DeathRecord,
  NightResolution,
  NightState,
  PlayerId,
  WitchInventory,
  WitchNightView,
} from './types';

export function createNightState(): NightState {
  return {
    stage: 'guard_seer',
    stageRevision: 0,
    guardComplete: false,
    seerComplete: false,
    actions: {
      guardTargetId: null,
      seerTargetId: null,
      wolfKillTargetId: null,
      witchUsesAntidote: false,
      witchPoisonTargetId: null,
    },
  };
}

export function completeGuard(
  state: NightState,
  targetId: PlayerId | null,
): NightState {
  return advanceGuardSeer({
    ...state,
    guardComplete: true,
    actions: { ...state.actions, guardTargetId: targetId },
  });
}

export function completeSeer(
  state: NightState,
  targetId: PlayerId | null,
): NightState {
  return advanceGuardSeer({
    ...state,
    seerComplete: true,
    actions: { ...state.actions, seerTargetId: targetId },
  });
}

function advanceGuardSeer(state: NightState): NightState {
  if (state.stage === 'guard_seer' && state.guardComplete && state.seerComplete) {
    return {
      ...state,
      stage: 'wolf_discussion',
      stageRevision: state.stageRevision + 1,
    };
  }
  return state;
}

export function startWolfVote(state: NightState): NightState {
  if (state.stage !== 'wolf_discussion') return state;
  return {
    ...state,
    stage: 'wolf_vote',
    stageRevision: state.stageRevision + 1,
  };
}

export function lockWolfKill(
  state: NightState,
  targetId: PlayerId | null,
): NightState {
  if (state.stage !== 'wolf_vote') return state;
  return {
    ...state,
    stage: 'witch',
    stageRevision: state.stageRevision + 1,
    actions: { ...state.actions, wolfKillTargetId: targetId },
  };
}

export function completeWitch(
  state: NightState,
  useAntidote: boolean,
  poisonTargetId: PlayerId | null,
): NightState {
  if (state.stage !== 'witch') return state;
  return {
    ...state,
    stage: 'resolve',
    stageRevision: state.stageRevision + 1,
    actions: {
      ...state.actions,
      witchUsesAntidote: useAntidote,
      witchPoisonTargetId: poisonTargetId,
    },
  };
}

export function getWitchNightView(
  wolfKillTargetId: PlayerId | null,
  guardTargetId: PlayerId | null,
  inventory: WitchInventory,
): WitchNightView {
  const guardBlockedKill =
    wolfKillTargetId !== null && wolfKillTargetId === guardTargetId;
  const visibleTarget = guardBlockedKill ? null : wolfKillTargetId;
  return {
    hasKillNotice: visibleTarget !== null,
    killTargetId: visibleTarget,
    canUseAntidote: visibleTarget !== null && inventory.antidote > 0,
  };
}

export function resolveNight(
  players: readonly CorePlayer[],
  state: NightState,
): NightResolution {
  const { guardTargetId, wolfKillTargetId, witchUsesAntidote, witchPoisonTargetId } =
    state.actions;
  const guardBlockedKill =
    wolfKillTargetId !== null && wolfKillTargetId === guardTargetId;
  const healedTargetId =
    !guardBlockedKill && witchUsesAntidote ? wolfKillTargetId : null;
  const wolfKillSucceeds =
    wolfKillTargetId !== null &&
    !guardBlockedKill &&
    healedTargetId !== wolfKillTargetId;

  const deaths: DeathRecord[] = [];
  if (wolfKillSucceeds && wolfKillTargetId !== null) {
    deaths.push({ playerId: wolfKillTargetId, cause: 'wolf_kill' });
  }
  if (
    witchPoisonTargetId !== null &&
    !deaths.some((death) => death.playerId === witchPoisonTargetId)
  ) {
    deaths.push({ playerId: witchPoisonTargetId, cause: 'poison' });
  }

  const deadIds = new Set(deaths.map((death) => death.playerId));
  return {
    players: players.map((player) =>
      deadIds.has(player.id) ? { ...player, alive: false } : { ...player },
    ),
    deaths,
    guardedTargetId: guardTargetId,
    healedTargetId,
    poisonedTargetId: witchPoisonTargetId,
    peacefulNight: deaths.length === 0,
    publicDeaths: deaths.map((death) => death.playerId),
  };
}

export function getSeerResult(
  players: readonly CorePlayer[],
  targetId: PlayerId,
): Alignment | null {
  const target = players.find((player) => player.id === targetId && player.alive);
  if (!target) return null;
  return target.role === 'wolf' ? 'wolf' : 'good';
}
