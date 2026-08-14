const STORAGE_META_PREFIX = 'wolf-online-meta-';

export interface OnlineMeta {
  playerId: string;
  name: string;
  spectator?: boolean;
  /** 进入令牌（P0-2）：加入者凭「房间码 + 令牌」进入，重连时用于恢复身份 */
  token?: string;
}

export const saveOnlineMeta = (code: string, meta: OnlineMeta): void => {
  try {
    sessionStorage.setItem(STORAGE_META_PREFIX + code, JSON.stringify(meta));
  } catch {
    /* ignore */
  }
};

export const loadOnlineMeta = (code: string): OnlineMeta | null => {
  try {
    const raw = sessionStorage.getItem(STORAGE_META_PREFIX + code);
    return raw ? (JSON.parse(raw) as OnlineMeta) : null;
  } catch {
    return null;
  }
};
