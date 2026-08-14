import { useCallback, useEffect, useState } from 'react';

export function useVoteDraft(roomCode: string, playerId: string | null) {
  const key = `wolf-vote-draft:${roomCode}:${playerId || 'spectator'}`;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => { try { setSelectedId(localStorage.getItem(key)); } catch { setSelectedId(null); } }, [key]);
  const select = useCallback((id: string | null) => { setSelectedId(id); try { if (id) localStorage.setItem(key, id); else localStorage.removeItem(key); } catch { /* storage unavailable */ } }, [key]);
  return { selectedId, select, clear: () => select(null) };
}
