import type { AIRequestContext } from './types';

export interface RepeatScene {
  gameId: string;
  playerId: string;
  phase: string;
  stage: string | null;
}

export interface RepeatRecord extends RepeatScene {
  text: string;
}

export interface RepeatCheck {
  repeated: boolean;
  similarity: number;
  consecutive: number;
  matchedText?: string;
  guidance: string;
}

const MAX_HISTORY_PER_SCENE = 12;
const SIMILARITY_THRESHOLD = 0.72;

const sceneKey = (scene: RepeatScene): string =>
  [scene.gameId, scene.playerId, scene.phase, scene.stage ?? 'none'].join(':');

const normalize = (value: string): string =>
  value
    .trim()
    .replace(/^(?:我觉得|说实话|讲道理|其实|总之|反正|个人觉得|嗯|呃)\s*[,，:：]?\s*/u, '')
    .replace(/[\s，。！？、；：（）“”"'`·…—\-:：,.!?;《》【】]/gu, '')
    .toLowerCase();

const grams = (value: string, size = 3): Set<string> => {
  if (!value) return new Set();
  if (value.length <= size) return new Set([value]);
  const result = new Set<string>();
  for (let index = 0; index <= value.length - size; index += 1) {
    result.add(value.slice(index, index + size));
  }
  return result;
};

const lcsLength = (left: string, right: string): number => {
  const row = new Array<number>(right.length + 1).fill(0);
  for (const leftChar of left) {
    let diagonal = 0;
    for (let index = 1; index <= right.length; index += 1) {
      const above = row[index];
      row[index] =
        leftChar === right[index - 1]
          ? diagonal + 1
          : Math.max(row[index], row[index - 1]);
      diagonal = above;
    }
  }
  return row[right.length];
};

export const speechSimilarity = (left: string, right: string): number => {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.92;
  const leftGrams = grams(a);
  const rightGrams = grams(b);
  let intersection = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) intersection += 1;
  }
  const union = new Set([...leftGrams, ...rightGrams]).size;
  const jaccard = union === 0 ? 0 : intersection / union;
  const sequence =
    Math.min(a.length, b.length) === 0
      ? 0
      : lcsLength(a, b) / Math.min(a.length, b.length);
  return Math.max(jaccard, sequence);
};

const isSpeechCommand = (
  commandType: string,
): commandType is 'game.speak' | 'game.wolf_speak' =>
  commandType === 'game.speak' || commandType === 'game.wolf_speak';

export class RepeatPolicy {
  private readonly records = new Map<string, RepeatRecord[]>();

  inspect(scene: RepeatScene, text: string): RepeatCheck {
    const key = sceneKey(scene);
    const history = this.records.get(key) ?? [];
    const normalized = normalize(text);
    let bestSimilarity = 0;
    let matchedText: string | undefined;
    for (const record of history) {
      const similarity = speechSimilarity(normalized, record.text);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        matchedText = record.text;
      }
    }
    const consecutive = history.length >= 2
      ? history
          .slice(-2)
          .filter((record) => speechSimilarity(record.text, text) >= SIMILARITY_THRESHOLD)
          .length
      : 0;
    const repeated =
      bestSimilarity >= SIMILARITY_THRESHOLD || consecutive >= 2;
    return {
      repeated,
      similarity: bestSimilarity,
      consecutive,
      matchedText,
      guidance: repeated
        ? '换一种说法：不要复述旧结论。补充一个尚未使用的具体证据、回应刚出现的新信息，或提出一个能获得新信息的具体问题，并明确下一步行动。'
        : '',
    };
  }

  record(scene: RepeatScene, text: string): void {
    const key = sceneKey(scene);
    const history = this.records.get(key) ?? [];
    history.push({ ...scene, text: text.trim() });
    while (history.length > MAX_HISTORY_PER_SCENE) history.shift();
    this.records.set(key, history);
  }

  acceptSpeech(context: AIRequestContext, text: string): RepeatCheck {
    const scene: RepeatScene = {
      gameId: context.gameId,
      playerId: context.playerId,
      phase: context.phase,
      stage: context.stage,
    };
    const result = this.inspect(scene, text);
    if (!result.repeated) this.record(scene, text);
    return result;
  }

  reset(): void {
    this.records.clear();
  }

  static isSpeechCommand = isSpeechCommand;
}

export const repeatSceneFromContext = (context: AIRequestContext): RepeatScene => ({
  gameId: context.gameId,
  playerId: context.playerId,
  phase: context.phase,
  stage: context.stage,
});
