import type {
  CognitionPlayer,
  CognitionStateV2,
  CreateCognitionStateInput,
  OwnerCognition,
  PlayerId,
  WolfAttackBoard,
  WolfConsensus,
} from './types';

export const emptyWolfConsensus = (): WolfConsensus => ({
  status: 'empty',
  targetId: null,
  backupTargetId: null,
  decisiveReasonCode: null,
  coverage: 0,
  supportRatio: 0,
  oppositionRatio: 0,
  scoreMargin: 0,
  fingerprint: null,
  evidenceEventIds: [],
});

const sortedPlayers = (players: readonly CognitionPlayer[]): CognitionPlayer[] =>
  [...players].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));

const createOwnerMemory = (
  gameId: string,
  player: CognitionPlayer,
  deathCutoffSequence: number | null | undefined,
): OwnerCognition => ({
  owner: {
    playerId: player.id,
    role: player.role,
    ...(deathCutoffSequence === undefined ? {} : { deathCutoffSequence }),
  },
  throughSequence: 0,
  facts: { byId: {}, orderedIds: [] },
  discourse: { utterancesById: {}, utteranceIds: [], claimsById: {}, claimIds: [] },
  votes: { commitmentsById: {}, commitmentIds: [], ballotsByKey: {}, ballotKeys: [] },
  playerModel: {
    stancesByClaimId: {},
    stanceClaimIds: [],
    disagreementsById: {},
    disagreementIds: [],
    contradictionsById: {},
    contradictionIds: [],
  },
  strategy: {
    ownerId: player.id,
    gameId,
    throughSequence: 0,
    priorities: [],
    publicCommitmentIds: [],
    openQuestionClaimIds: [],
    nextActionCandidates: [],
    doNotRepeatFingerprints: [],
    lastDecisionSummaries: [],
  },
});

const createWolfAttackBoard = (
  gameId: string,
  players: readonly CognitionPlayer[],
): WolfAttackBoard | null => {
  const knownWolfIds = players.filter((player) => player.role === 'wolf').map((player) => player.id);
  if (knownWolfIds.length === 0) return null;
  const preferencesByWolf = Object.fromEntries(knownWolfIds.map((id) => [id, []]));
  return {
    gameId,
    planVersion: 0,
    throughSequence: 0,
    currentWindow: 0,
    knownWolfIds,
    aliveWolfIds: players.filter((player) => player.role === 'wolf' && player.isAlive).map((player) => player.id),
    legalTargetIds: players.filter((player) => player.role !== 'wolf' && player.isAlive).map((player) => player.id),
    route: { value: 'uncommitted', basis: 'none', evidenceEventIds: [], confidence: 'low' },
    featureContributionsById: {},
    featureContributionIds: [],
    candidatesById: {},
    preferencesByWolf,
    consensus: emptyWolfConsensus(),
    lockedKill: null,
    completedLocks: [],
    recentPlanFingerprints: [],
  };
};

export const createCognitionState = (input: CreateCognitionStateInput): CognitionStateV2 => {
  const players = sortedPlayers(input.players);
  const playersById = Object.fromEntries(players.map((player) => [player.id, { ...player }]));
  const requestedOwners = new Set<PlayerId>(input.ownerIds ?? players.map((player) => player.id));
  const ownerMemoriesById = Object.fromEntries(
    players
      .filter((player) => requestedOwners.has(player.id))
      .map((player) => [
        player.id,
        createOwnerMemory(
          input.gameId,
          player,
          input.deathCutoffSequenceByOwner?.[player.id],
        ),
      ]),
  );
  return {
    schemaVersion: 2,
    gameId: input.gameId,
    throughSequence: 0,
    playersById,
    ownerMemoriesById,
    wolfAttackBoard: createWolfAttackBoard(input.gameId, players),
    appliedEventIds: [],
    appliedEventIdSet: {},
    consolidatedCheckpointIds: [],
  };
};
