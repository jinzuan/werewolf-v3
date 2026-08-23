export const PLAYER_NICKNAME_KEY = 'werewolf-v3-player-nickname';
export const DEFAULT_PLAYER_NICKNAME = '玩家';
export const PLAYER_NICKNAME_MAX_LENGTH = 16;
export const PLAYER_BIO_KEY = 'werewolf-v3-player-bio';
export const PLAYER_AVATAR_KEY = 'werewolf-v3-player-avatar';
export const PLAYER_BIO_MAX_LENGTH = 80;
export const PLAYER_AVATAR_IDS = ['avatar-player', 'avatar-spectator', 'avatar-computer'] as const;
export type PlayerAvatarId = (typeof PLAYER_AVATAR_IDS)[number];

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'getItem' | 'setItem'>;

const browserStorage = (): Storage | null =>
  typeof localStorage === 'undefined' ? null : localStorage;

export const normalizePlayerNickname = (value: string): string =>
  value.trim().slice(0, PLAYER_NICKNAME_MAX_LENGTH) || DEFAULT_PLAYER_NICKNAME;

export const normalizePlayerBio = (value: string): string =>
  [...value]
    .map((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character)
    .join('')
    .trim()
    .slice(0, PLAYER_BIO_MAX_LENGTH);

export const normalizePlayerAvatarId = (value: string): PlayerAvatarId =>
  (PLAYER_AVATAR_IDS as readonly string[]).includes(value) ? value as PlayerAvatarId : 'avatar-player';

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

export const readPlayerBio = (storage: ReadStorage | null = browserStorage()): string => {
  if (!storage) return '';
  try { return normalizePlayerBio(storage.getItem(PLAYER_BIO_KEY) ?? ''); } catch { return ''; }
};

export const readPlayerAvatarId = (storage: ReadStorage | null = browserStorage()): PlayerAvatarId => {
  if (!storage) return 'avatar-player';
  try { return normalizePlayerAvatarId(storage.getItem(PLAYER_AVATAR_KEY) ?? 'avatar-player'); } catch { return 'avatar-player'; }
};

export const writePlayerProfile = (
  profile: { nickname: string; bio: string; avatarId: string },
  storage: WriteStorage | null = browserStorage(),
): { nickname: string; bio: string; avatarId: PlayerAvatarId } => {
  const normalized = {
    nickname: normalizePlayerNickname(profile.nickname),
    bio: normalizePlayerBio(profile.bio),
    avatarId: normalizePlayerAvatarId(profile.avatarId),
  };
  try {
    storage?.setItem(PLAYER_NICKNAME_KEY, normalized.nickname);
    storage?.setItem(PLAYER_BIO_KEY, normalized.bio);
    storage?.setItem(PLAYER_AVATAR_KEY, normalized.avatarId);
  } catch { /* local profile is a convenience cache */ }
  return normalized;
};
