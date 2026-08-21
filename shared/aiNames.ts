/**
 * Public display names for computer players. The server chooses a random
 * subset at game start; the client uses the same list only to repair legacy
 * placeholder names that may still exist in an already persisted room.
 */
export const AI_NAME_POOL = [
  '小雨', '阿杰', '小雅', '阿诚', '小安', '小北', '子轩', '梓涵', '浩然', '思远', '清风', '星河', '王大锤', '李大嘴', '张三', '赵六', '不吃香菜', '摸鱼王', '稳住别浪', '全村希望', '隔壁老王', '今天吃啥', '锅盖侠', '躺赢选手', '平平无奇', '先苟一波', '好运来', '村口老张', '子墨', '景行', '书宁', '林深', '远山', '云舒', '初一', '十七', '白露', '山月', '长安', '安然', '松子', '小满', '阿宁', '阿乐', '小程', '小苏', '小林', '小叶', '小顾', '小周', '予安', '程野', '苏木', '顾安', '叶子', '五月', '七七', '十一', '小麦', '素问', '清和', '景明', '时雨', '望舒', '如初', '小风', '小月', '小山', '小云', '小松', '小明', '小远', '小白', '小墨', '小宁', '阿雨', '阿风', '阿山', '阿月', '阿林', '阿叶', '阿周', '阿明', '阿远', '阿墨', '阿松', '子安', '子宁', '子雨', '子风', '子山', '子云', '子林', '子明', '子远', '子舒', '子问', '子和', '林安', '林宁', '林雨', '林风', '林月', '林山', '林远', '林明', '林舒', '林墨', '云安', '云宁', '云山', '云林', '云明', '云远', '云初', '云墨', '云松', '长宁', '安宁', '苏安'
] as const;

/** Names emitted by the pre-Chinese-name allocator. */
export const isLegacyAIName = (name: string): boolean =>
  /^(?:电脑(?:玩家)?|AI)\s*[-_#]?\s*\d+$/iu.test(name.trim());

/** Stable browser fallback for old snapshots; seat order keeps AI names unique. */
export const fallbackAIName = (order: number): string => {
  const index = Math.max(0, Math.floor(order) - 1);
  return AI_NAME_POOL[index % AI_NAME_POOL.length] ?? '小雨';
};
