import type { AIRequestContext } from './types';

const cleanFact = (value: string | undefined): string =>
  value?.replace(/^[^：:]{1,24}[：:]/u, '').replace(/\s+/gu, ' ').trim().slice(0, 34) ?? '';

/**
 * A degraded turn must still sound like a response to this table, not like a
 * shared canned sentence. It deliberately uses only projected public context
 * and a stable actor/stage rotation; no secret or hidden role fact is added.
 */
export const fallbackSpeechContent = (context: AIRequestContext): string => {
  const prompt = context.promptContext;
  const alive = context.players.filter((player) => player.isAlive);
  const actor = context.players.find((player) => player.id === context.playerId);
  const candidates = alive.filter((player) => player.id !== context.playerId);
  const target = candidates[(context.stageRevision + stableIndex(context.playerId)) % Math.max(1, candidates.length)];
  const recent = cleanFact(
    prompt?.newInformationSinceLastTurn?.at(-1) ?? prompt?.currentRoundSpeeches?.at(-1),
  );
  const day = prompt?.dayNumber ?? '?';
  const targetName = target?.name ?? '场上玩家';
  const subject = recent || `目前有${alive.length}名玩家存活`;
  const variants = [
    `第${day}天我先关注${targetName}：${subject}。我会听他下一轮解释，再决定是否调整判断。`,
    `第${day}天我暂时把票型和${targetName}放在一起看。${subject}，现在不急着下定论，但需要他回应具体矛盾。`,
    `第${day}天从公开信息看，${subject}。我对${targetName}保留怀疑，想先确认他的发言和投票是否一致。`,
    `第${day}天这一轮我不复述前面的结论：${subject}。我会继续观察${targetName}的立场变化，再给出更明确的判断。`,
  ];
  return variants[(context.stageRevision + stableIndex(actor?.id ?? context.playerId)) % variants.length];
};

const stableIndex = (value: string): number => {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash;
};

export const fallbackWolfSpeechContent = (context: AIRequestContext): string => {
  const prompt = context.promptContext;
  const alive = context.players.filter((player) => player.isAlive);
  const recent = cleanFact(
    prompt?.wolfTeamDisagreement ||
      prompt?.currentRoundSpeeches?.at(-1) ||
      prompt?.wolfPrivateChat?.at(-1),
  );
  const legalTargets = prompt?.legalTargets?.length
    ? prompt.legalTargets
    : alive.map((player) => ({ id: player.id, name: player.name }));
  const target = legalTargets[(context.stageRevision + stableIndex(context.playerId)) % Math.max(1, legalTargets.length)];
  const round = prompt?.wolfDiscussionRound ?? 1;
  const variants = [
    `狼队第${round}/2轮讨论，我建议先考虑击杀${target?.name ?? '目标'}；${recent || '请队友说明是否有更稳妥的刀口'}。`,
    `今晚要先定击杀目标，不要聊白天站边。${target?.name ?? '这个目标'}可以优先评估，${recent || '如果反对请直接报出替代目标'}。`,
    `现在有${alive.length}名玩家存活，我把${target?.name ?? '这名玩家'}列为今晚的击杀候选，理由是公开信息和存活收益；请队友补充风险或改报目标。`,
  ];
  return variants[(context.stageRevision + stableIndex(context.playerId)) % variants.length];
};
