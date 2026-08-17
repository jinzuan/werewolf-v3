export const PLAYER_NICKNAME_KEY = 'werewolf-v3-player-nickname';
export const DEFAULT_PLAYER_NICKNAME = '玩家';
export const PLAYER_NICKNAME_MAX_LENGTH = 16;

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'getItem' | 'setItem'>;

const browserStorage = (): Storage | null =>
  typeof localStorage === 'undefined' ? null : localStorage;

export const normalizePlayerNickname = (value: string): string =>
  value.trim().slice(0, PLAYER_NICKNAME_MAX_LENGTH) || DEFAULT_PLAYER_NICKNAME;

export const readPlayerNickname = (
  storage: ReadStorage | null = browserStorage(),
): string => {
  if (!storage) return DEFAULT_PLAYER_NICKNAME;
  try {
    const value = storage.getItem(PLAYER_NICKNAME_KEY);
    return typeof value === 'string' && value.trim()
      ? normalizePlayerNickname(value)
      : DEFAULT_PLAYER_NICKNAME;
  } catch {
    return DEFAULT_PLAYER_NICKNAME;
  }
};

/** Save the profile name and return the exact value used by room commands. */
export const writePlayerNickname = (
  value: string,
  storage: WriteStorage | null = browserStorage(),
): string => {
  const normalized = normalizePlayerNickname(value);
  try {
    storage?.setItem(PLAYER_NICKNAME_KEY, normalized);
  } catch {
    // A private browsing context may reject localStorage. The current form
    // value still remains usable for this request.
  }
  return normalized;
};
