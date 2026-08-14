import { useCallback, useEffect, useState } from 'react';

function storageKey(roomCode: string, playerId: string | null) {
  return `wolf-day-draft:${roomCode}:${playerId || 'spectator'}`;
}

export function useDaytimeDraft(roomCode: string, playerId: string | null) {
  const key = storageKey(roomCode, playerId);
  const [draft, setDraftState] = useState('');
  useEffect(() => {
    try { setDraftState(localStorage.getItem(key) || ''); } catch { setDraftState(''); }
  }, [key]);
  const setDraft = useCallback((value: string) => {
    setDraftState(value);
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch { /* storage unavailable */ }
  }, [key]);
  const clearDraft = useCallback(() => setDraft(''), [setDraft]);
  return { draft, setDraft, clearDraft };
}
