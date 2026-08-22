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
  const recent = cleanFact(prompt?.currentRoundSpeeches?.at(-1));
  const target = alive[(context.stageRevision + stableIndex(context.playerId)) % Math.max(1, alive.length)];
  const variants = [
    `现在有${alive.length}名玩家存活，我倾向先观察${target?.name ?? '目标'}的公开反应，${recent || '不要让票型过早暴露我们的方向'}。`,
    `现在有${alive.length}名玩家存活，这轮先别急着统一说法；${recent || '可以让一人保留怀疑，其他人再根据场上反应调整'}。`,
    `现在有${alive.length}名玩家存活，我会把${target?.name ?? '这名玩家'}列为重点观察对象，先听他回应，再决定是否跟进。`,
  ];
  return variants[(context.stageRevision + stableIndex(context.playerId)) % variants.length];
};
