import { useEffect } from 'react';
import { getSocket } from '../net/socket';
import { useOnlineStore } from '../stores/onlineStore';
import { useGameStore } from '../stores/gameStore';
import type { DebugLogEntry, DebugSnapshot, Snapshot } from '../net/protocol';

/**
 * useOnlineGame — 联机房间同步钩子：
 * 监听 socket 的 snapshot/error/connect/disconnect 事件，
 * 把服务端个性化快照灌入 onlineStore + gameStore，驱动现有 UI 组件渲染。
 */
export function useOnlineGame(roomCode: string) {
  const setSnapshot = useOnlineStore((s) => s.setSnapshot);
  const setConnected = useOnlineStore((s) => s.setConnected);
  const setServerError = useOnlineStore((s) => s.setServerError);
  const setConnectionNotice = useOnlineStore((s) => s.setConnectionNotice);
  const setDebugSnapshot = useOnlineStore((s) => s.setDebugSnapshot);
  const setDebugLogs = useOnlineStore((s) => s.setDebugLogs);
  const applySnapshot = useGameStore((s) => s.applyOnlineSnapshot);

  useEffect(() => {
    const s = getSocket();
    if (!s) return;

    const onSnap = (snap: Snapshot) => {
      if (snap.roomCode !== roomCode) return;
      setSnapshot(snap);
      applySnapshot(snap);
    };
    const onErr = (e: { message?: string }) => setServerError(e?.message || '服务端错误');
    const onHostError = (e: { message?: string }) => setServerError(e?.message || '该操作仅房主可执行');
    const onConnect = () => {
      setConnected(true);
      setConnectionNotice('已连接');
    };
    const onDisconnect = () => {
      setConnected(false);
      setConnectionNotice('连接已断开，正在尝试重连…');
    };
    const onConnectError = () => {
      setConnected(false);
      setConnectionNotice('无法连接服务端，正在重试…');
    };
    const onDebugSnapshot = (debug: DebugSnapshot) => {
      const current = useOnlineStore.getState().snapshot;
      if (current?.roomCode === roomCode && current.isHost && current.debugMode) setDebugSnapshot(debug);
    };
    const onDebugLogs = (logs: DebugLogEntry[]) => {
      const current = useOnlineStore.getState().snapshot;
      if (current?.roomCode === roomCode && current.isHost && current.debugMode) setDebugLogs(logs);
    };

    s.on('snapshot', onSnap);
    s.on('error', onErr);
    s.on('host-error', onHostError);
    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    s.on('connect_error', onConnectError);
    s.on('debug:snapshot', onDebugSnapshot);
    s.on('debug:log', onDebugLogs);
    if (s.connected) setConnected(true);

    return () => {
      s.off('snapshot', onSnap);
      s.off('error', onErr);
      s.off('host-error', onHostError);
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      s.off('connect_error', onConnectError);
      s.off('debug:snapshot', onDebugSnapshot);
      s.off('debug:log', onDebugLogs);
    };
  }, [roomCode, setSnapshot, setConnected, setServerError, setConnectionNotice, applySnapshot]);
}
