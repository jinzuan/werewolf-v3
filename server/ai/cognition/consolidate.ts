import { consolidateStrategyNotebook } from './strategyNotebook';
import type { CognitionStateV2, ConsolidationCheckpoint } from './types';
import { reconcileVoteCommitments } from './voteLedger';
import { consolidateWolfAttackBoard } from './wolfAttackBoard';

/** Idempotent checkpoint reducer; no model or wall-clock dependency. */
export const consolidate = (
  current: CognitionStateV2,
  checkpoint: ConsolidationCheckpoint,
): CognitionStateV2 => {
  if (current.consolidatedCheckpointIds.includes(checkpoint.id)) return current;
  const next = structuredClone(current);
  const alive = new Set(checkpoint.alivePlayerIds);
  for (const player of Object.values(next.playersById)) player.isAlive = alive.has(player.id);
  for (const owner of Object.values(next.ownerMemoriesById)) {
    if (checkpoint.kind === 'night_open') reconcileVoteCommitments(owner, checkpoint.day);
    consolidateStrategyNotebook(owner, checkpoint.kind, alive);
    owner.throughSequence = Math.max(owner.throughSequence, checkpoint.throughSequence);
    owner.strategy.throughSequence = Math.max(owner.strategy.throughSequence, checkpoint.throughSequence);
  }
  if (next.wolfAttackBoard) consolidateWolfAttackBoard(next.wolfAttackBoard, checkpoint);
  next.throughSequence = Math.max(next.throughSequence, checkpoint.throughSequence);
  next.consolidatedCheckpointIds.push(checkpoint.id);
  return next;
};
