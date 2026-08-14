import { useCallback, useEffect, useState } from 'react';

export type NightActionKind = 'kill' | 'check' | 'heal' | 'poison' | 'guard';
interface NightDraft { action: NightActionKind | null; targetId: string | null }

function storageKey(roomCode: string, playerId: string | null, nightKey: string) {
  return 'wolf-night-draft:' + roomCode + ':' + (playerId || 'spectator') + ':' + nightKey;
}

export function useNightActionDraft(roomCode: string, playerId: string | null, nightKey = 'current') {
  const key = storageKey(roomCode, playerId, nightKey);
  const [draft, setDraftState] = useState<NightDraft>({ action: null, targetId: null });
  useEffect(() => {
    const readDraft = () => {
      try {
        const saved = localStorage.getItem(key);
        if (!saved) return setDraftState({ action: null, targetId: null });
        const parsed = JSON.parse(saved) as Partial<NightDraft>;
        const actions: NightActionKind[] = ['kill', 'check', 'heal', 'poison', 'guard'];
        setDraftState({ action: actions.includes(parsed.action as NightActionKind) ? parsed.action as NightActionKind : null, targetId: typeof parsed.targetId === 'string' ? parsed.targetId : null });
      } catch { setDraftState({ action: null, targetId: null }); }
    };
    readDraft();
    const onStorage = (event: StorageEvent) => { if (event.key === key) readDraft(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key, nightKey]);

  /* 仅存储可恢复的草稿，不写入行动结果；服务端锁定仍是唯一裁决。 */
  useEffect(() => {
    try {
      if (draft.action || draft.targetId) localStorage.setItem(key, JSON.stringify(draft));
    } catch { /* storage unavailable */ }
  }, [draft, key]);
  const setDraft = useCallback((next: Partial<NightDraft>) => {
    setDraftState((current) => {
      const value = { ...current, ...next };
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
      return value;
    });
  }, [key]);
  const clearDraft = useCallback(() => {
    setDraftState({ action: null, targetId: null });
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  }, [key]);
  return { draft, setDraft, clearDraft };
}
