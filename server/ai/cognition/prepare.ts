import type {
  CognitionStateV2,
  PrepareDecisionInput,
  PreparedMemoryContext,
} from './types';

const bySource = <T extends { source: { sequence: number; eventId: string } }>(left: T, right: T) =>
  right.source.sequence - left.source.sequence || left.source.eventId.localeCompare(right.source.eventId);

/** Read-only, deterministic projection for a single owner and legal task. */
export const prepare = (
  state: CognitionStateV2,
  input: PrepareDecisionInput,
): PreparedMemoryContext => {
  const owner = state.ownerMemoriesById[input.ownerId];
  if (!owner) throw new Error(`COGNITION_OWNER_NOT_FOUND:${input.ownerId}`);
  const requestedLimit = Math.max(1, Math.floor(input.maxItems ?? (input.mode === 'compact' ? 6 : 12)));
  const factsAll = owner.facts.orderedIds
    .map((id) => owner.facts.byId[id])
    .filter((fact) => fact.source.sequence <= input.asOfSequence)
    .sort(bySource);
  const claimsAll = owner.discourse.claimIds
    .map((id) => owner.discourse.claimsById[id])
    .filter((claim) => {
      const utterance = owner.discourse.utterancesById[`utterance:${claim.eventId}`];
      return Boolean(utterance && utterance.source.sequence <= input.asOfSequence);
    })
    .sort((left, right) => {
      const leftSource = owner.discourse.utterancesById[`utterance:${left.eventId}`].source;
      const rightSource = owner.discourse.utterancesById[`utterance:${right.eventId}`].source;
      return rightSource.sequence - leftSource.sequence || left.claimId.localeCompare(right.claimId);
    });
  const facts = factsAll.slice(0, requestedLimit);
  const claims = claimsAll.slice(0, requestedLimit);
  const openCommitments = owner.votes.commitmentIds
    .map((id) => owner.votes.commitmentsById[id])
    .filter((commitment) => commitment.status === 'open' && commitment.source.sequence <= input.asOfSequence);
  const commitmentOutcomes = owner.votes.commitmentIds
    .map((id) => owner.votes.commitmentsById[id])
    .filter((commitment) => commitment.status !== 'open' && commitment.source.sequence <= input.asOfSequence)
    .slice(-requestedLimit);
  const disagreements = owner.playerModel.disagreementIds
    .map((id) => owner.playerModel.disagreementsById[id])
    .slice(-requestedLimit);
  const contradictions = owner.playerModel.contradictionIds
    .map((id) => owner.playerModel.contradictionsById[id])
    .slice(-requestedLimit);

  const packet: PreparedMemoryContext = {
    ownerId: input.ownerId,
    asOfSequence: Math.min(input.asOfSequence, state.throughSequence),
    stageRevision: input.stageRevision,
    legalActions: [...input.legalActions],
    legalTargetIds: [...input.legalTargetIds],
    facts,
    claims,
    openCommitments,
    commitmentOutcomes,
    disagreements,
    contradictions,
    priorities: owner.strategy.priorities.filter((priority) =>
      !priority.targetId || input.legalTargetIds.includes(priority.targetId),
    ),
    openQuestionClaimIds: [...owner.strategy.openQuestionClaimIds],
    avoidFingerprints: [...owner.strategy.doNotRepeatFingerprints],
    omitted: {
      facts: Math.max(0, factsAll.length - facts.length),
      claims: Math.max(0, claimsAll.length - claims.length),
    },
  };

  const board = state.wolfAttackBoard;
  if (owner.owner.role === 'wolf' && board) {
    const legal = new Set(input.legalTargetIds);
    const candidates = Object.values(board.candidatesById)
      .filter((candidate) => legal.has(candidate.targetId) && candidate.legal && !candidate.teammate)
      .sort((left, right) =>
        right.finalScore - left.finalScore ||
        input.legalTargetIds.indexOf(left.targetId) - input.legalTargetIds.indexOf(right.targetId),
      )
      .slice(0, input.mode === 'compact' ? 3 : 6)
      .map(({ targetId, tacticalScore, finalScore }) => ({ targetId, tacticalScore, finalScore }));
    packet.wolfTeam = {
      candidates,
      consensus: board.consensus,
      alternatives: candidates
        .map((candidate) => candidate.targetId)
        .filter((id) => id !== board.consensus.targetId)
        .slice(0, 2),
      lockedTargetId: board.lockedKill?.targetId ?? null,
      shouldSkipRepeatedConsensus: board.consensus.status === 'agreed',
    };
  }
  return structuredClone(packet);
};
