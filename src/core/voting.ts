import type {
  CorePlayer,
  ExileVoteResult,
  LastWordsEligibility,
  PlayerId,
  VoteBallot,
  VoteTally,
  WolfVoteResult,
} from './types';
import { validateVoteChoice } from './validation';

export function tallyVotes(ballots: readonly VoteBallot[]): VoteTally {
  const counts: Record<PlayerId, number> = {};
  for (const ballot of ballots) {
    if (ballot.targetId !== null) {
      counts[ballot.targetId] = (counts[ballot.targetId] ?? 0) + 1;
    }
  }
  const maxVotes = Math.max(0, ...Object.values(counts));
  const leaders =
    maxVotes === 0
      ? []
      : Object.keys(counts)
          .filter((playerId) => counts[playerId] === maxVotes)
          .sort();
  return { counts, leaders, maxVotes };
}

export function resolveWolfVote(
  ballots: readonly VoteBallot[],
  rng: () => number = Math.random,
): WolfVoteResult {
  const tally = tallyVotes(ballots);
  if (tally.leaders.length === 1) {
    return { status: 'kill_locked', targetId: tally.leaders[0] };
  }
  if (tally.leaders.length === 0) {
    return { status: 'kill_locked', targetId: null };
  }

  const randomValue = rng();
  const randomIndex = Number.isFinite(randomValue)
    ? Math.floor(randomValue * tally.leaders.length)
    : 0;
  const index = Math.min(
    tally.leaders.length - 1,
    Math.max(0, randomIndex),
  );
  return { status: 'kill_locked', targetId: tally.leaders[index] };
}

export function getExileVoteEligibility(
  players: readonly CorePlayer[],
  round: 1 | 2,
  tiedCandidates: readonly PlayerId[] = [],
): { voterIds: readonly PlayerId[]; targetIds: readonly PlayerId[]; abstainAllowed: boolean } {
  const aliveIds = players.filter((player) => player.alive).map((player) => player.id);
  if (round === 1) {
    return { voterIds: aliveIds, targetIds: aliveIds, abstainAllowed: true };
  }
  return {
    voterIds: aliveIds.filter((playerId) => !tiedCandidates.includes(playerId)),
    targetIds: [...tiedCandidates],
    abstainAllowed: false,
  };
}

export function resolveExileVote(
  players: readonly CorePlayer[],
  ballots: readonly VoteBallot[],
  round: 1 | 2,
  tiedCandidates: readonly PlayerId[] = [],
): ExileVoteResult {
  const eligibility = getExileVoteEligibility(players, round, tiedCandidates);
  const validBallots = ballots.filter(
    (ballot) => validateVoteChoice(ballot.voterId, ballot.targetId, {
      eligibleVoterIds: eligibility.voterIds,
      eligibleTargetIds: eligibility.targetIds,
      abstainAllowed: eligibility.abstainAllowed,
    }).ok,
  );
  const tally = tallyVotes(validBallots);

  if (tally.leaders.length === 1) {
    return { status: 'exiled', targetId: tally.leaders[0], round, tally };
  }
  if (round === 1 && tally.leaders.length > 1) {
    return {
      status: 'revote_required',
      candidates: tally.leaders,
      eligibleVoterIds: eligibility.voterIds.filter(
        (playerId) => !tally.leaders.includes(playerId),
      ),
      round: 2,
      tally,
    };
  }
  return { status: 'no_exile', round, tally };
}

export function getLastWordsEligibility(
  deathCause: 'wolf_kill' | 'poison' | 'exile' | 'hunter_shot',
): LastWordsEligibility {
  if (deathCause !== 'exile') {
    return { eligible: false, maxRounds: 0, reason: 'death_cause_ineligible' };
  }
  return { eligible: true, maxRounds: 2, reason: 'exile_two_rounds' };
}

export function buildSpeechOrder(
  seatedPlayerIds: readonly PlayerId[],
  startPlayerId: PlayerId,
  direction: 'clockwise' | 'counterclockwise',
): readonly PlayerId[] {
  const startIndex = seatedPlayerIds.indexOf(startPlayerId);
  if (startIndex < 0) return [];
  return seatedPlayerIds.map((_, offset) => {
    const delta = direction === 'clockwise' ? offset : -offset;
    const index = (startIndex + delta + seatedPlayerIds.length) % seatedPlayerIds.length;
    return seatedPlayerIds[index];
  });
}
