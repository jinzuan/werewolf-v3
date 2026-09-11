export type JoinIntent = 'play' | 'watch';

export const normalizeJoinCode = (value: string | null | undefined): string =>
  (value ?? '').trim().replace(/\s+/g, '').toUpperCase();

export const joinIntentFromQuery = (value: string | null | undefined): JoinIntent =>
  value === 'watch' ? 'watch' : 'play';

export const joinActionLabel = (intent: JoinIntent): string =>
  intent === 'watch' ? '进入观战' : '加入房间';
