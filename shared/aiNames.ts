/**
 * Public display names for computer players. The server chooses a random
 * subset at game start; the client uses the same list only to repair legacy
 * placeholder names that may still exist in an already persisted room.
 */
export const AI_NAME_POOL = [
  '小雨', '阿杰', '小雅', '阿诚', '小安', '小北', '子轩', '梓涵',
  '浩然', '思远', '清风', '星河', '王大锤', '李大嘴', '张三', '赵六',
  '不吃香菜', '摸鱼王', '稳住别浪', '全村希望', '隔壁老王', '今天吃啥',
  '锅盖侠', '躺赢选手', '平平无奇', '先苟一波', '好运来', '村口老张',
] as const;

/** Names emitted by the pre-Chinese-name allocator. */
export const isLegacyAIName = (name: string): boolean =>
  /^(?:电脑(?:玩家)?|AI)\s*[-_#]?\s*\d+$/iu.test(name.trim());

/** Stable browser fallback for old snapshots; seat order keeps AI names unique. */
export const fallbackAIName = (order: number): string => {
  const index = Math.max(0, Math.floor(order) - 1);
  return AI_NAME_POOL[index % AI_NAME_POOL.length] ?? '小雨';
};
