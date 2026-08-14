import { useEffect, useRef } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
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
  const session = useV3Store((state) => state.session);
  const room = useV3Store((state) => state.room);
  const resumeSession = useV3Store((state) => state.resumeSession);
  const recoveryAttempted = useRef(false);

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

  return (
    <AppShell title="正在恢复房间" eyebrow="房间入口" connected={connected}>
      <Card className="v3-empty-state" aria-live="polite">
        <strong>正在恢复房间状态</strong>
        <span>正在核对当前身份与服务端房间权限，请稍候。</span>
      </Card>
    </AppShell>
  );
}
