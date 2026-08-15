import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/shell/AppShell';
import { useV3Store } from '../../stores/v3Store';
import { Card } from '../../ui/Card';
import {
  canonicalRoomPath,
  normalizeRoomCode,
  roomJoinPath,
} from './roomRouting';

/**
 * The index room route is intentionally not a page. It resumes the bound
 * identity, then replaces the URL with the one view allowed by RoomView.
 */
export function RoomResolverPage() {
  const { roomCode: rawRoomCode } = useParams();
  const navigate = useNavigate();
  const code = normalizeRoomCode(rawRoomCode);
  const connected = useV3Store((state) => state.connected);
  const authorityStatus = useV3Store((state) => state.authorityStatus);
  const recovering = useV3Store((state) => state.recovering);
  const error = useV3Store((state) => state.error);
  const session = useV3Store((state) => state.session);
  const room = useV3Store((state) => state.room);
  const resumeSession = useV3Store((state) => state.resumeSession);
  const recoveryAttempted = useRef(false);

  const retry = () => {
    recoveryAttempted.current = true;
    void resumeSession();
  };

  useEffect(() => {
    recoveryAttempted.current = false;
  }, [code]);

  useEffect(() => {
    if (!code) {
      navigate('/lobby', { replace: true });
      return;
    }

    // A URL cannot select another saved identity. The join page is the only
    // place where a new identity may be established.
    if (!session || session.roomCode !== code) {
      navigate(roomJoinPath(code), { replace: true });
      return;
    }

    if (room && room.code === code) {
      navigate(canonicalRoomPath(room), { replace: true });
      return;
    }

    if (
      !recoveryAttempted.current &&
      (authorityStatus === 'resolving' || authorityStatus === 'authorized')
    ) {
      recoveryAttempted.current = true;
      void resumeSession();
    }
  }, [
    authorityStatus,
    code,
    navigate,
    recovering,
    room,
    resumeSession,
    session,
  ]);

  if (!code) return null;

  if (authorityStatus === 'error') {
    return (
      <AppShell title="房间恢复失败" eyebrow="房间入口" connected={connected}>
        <Card className="v3-empty-state" aria-live="polite">
          <strong>暂时无法恢复房间</strong>
          <span>{error ?? '连接或房间状态暂时不可用。'}</span>
          <div className="v3-action-stack">
            <button type="button" onClick={retry}>重试</button>
            <button type="button" onClick={() => navigate('/lobby')}>返回大厅</button>
          </div>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell title="正在恢复房间" eyebrow="房间入口" connected={connected}>
      <Card className="v3-empty-state" aria-live="polite">
        <strong>正在恢复房间状态</strong>
        <span>正在核对你的房间身份，请稍候。</span>
      </Card>
    </AppShell>
  );
}
