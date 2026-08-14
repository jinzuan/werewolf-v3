import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sendAction } from '../net/socket';
import { useOnlineStore } from '../stores/onlineStore';
import type { ClientAction } from '../net/protocol';
import { formatCountdown, getRemainingMs, getServerOffset } from '../utils/countdown';

export function useGameEngine(roomCode: string, playerId: string | null) {
  const snapshot = useOnlineStore((state) => state.snapshot);
  const [now, setNow] = useState(Date.now);
  const receivedAtRef = useRef(0);
  const serverTimeRef = useRef<number | undefined>(undefined);
  if (snapshot?.serverTime && serverTimeRef.current !== snapshot.serverTime) {
    serverTimeRef.current = snapshot.serverTime;
    receivedAtRef.current = Date.now();
  }
  const receivedAt = receivedAtRef.current;
  const offset = useMemo(() => getServerOffset(snapshot?.serverTime, receivedAt), [snapshot?.serverTime, receivedAt]);

  useEffect(() => {
    if (!snapshot?.deadlineTs) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [snapshot?.deadlineTs]);

  const remainingMs = getRemainingMs(snapshot?.deadlineTs, offset, now);
  const deadlineExpired = remainingMs !== null && remainingMs <= 0;
  const act = useCallback((action: ClientAction) => {
    if (roomCode && playerId) sendAction(roomCode, playerId, action);
  }, [playerId, roomCode]);

  const me = snapshot?.players.find((player) => player.id === playerId);
  const state = snapshot?.gameState;
  const isMyTurn = !!me?.isAlive && state?.currentSpeaker === playerId;
  const isDay = state?.phase === 'day' || state?.phase === 'lastWords';
  const banner = useMemo(() => {
    if (!snapshot || !state) return { title: '等待开局', detail: '准备好后等待房主开始游戏', tone: 'quiet' as const };
    if (state.phase === 'hunterShoot') return { title: isMyTurn ? '轮到你开枪' : '猎人正在选择目标', detail: '确认前请查看开枪后的立即死亡后果', tone: 'danger' as const };
    if (state.phase === 'lastWords') return { title: isMyTurn ? '轮到你说遗言' : '遗言进行中', detail: isMyTurn ? '可以选择发言或跳过' : '请等待当前玩家完成遗言', tone: 'warning' as const };
    if (state.phase === 'voting' || state.phase === 'vote') return { title: '投票进行中', detail: `已有 ${snapshot.dayVoteCount} 人完成投票`, tone: 'accent' as const };
    if (state.phase === 'day') return { title: isMyTurn ? '轮到你发言' : `等待${snapshot.players.find((p) => p.id === state.currentSpeaker)?.name || '玩家'}发言`, detail: snapshot.thinkingPlayers[state.currentSpeaker || ''] !== undefined ? '正在组织发言' : '发言完成后进入下一位', tone: isMyTurn ? 'accent' as const : 'quiet' as const };
    return { title: '夜晚阶段', detail: '白天行动将在下一阶段开放', tone: 'quiet' as const };
  }, [isMyTurn, snapshot, state]);

  return { snapshot, state, me, isDay, isMyTurn, banner, remainingMs, deadlineExpired, countdown: formatCountdown(remainingMs), act };
}
