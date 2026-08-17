import { Navigate, Outlet, useLocation, useParams } from 'react-router-dom';
import { AppShell } from '../../components/shell/AppShell';
import { useV3Store } from '../../stores/v3Store';
import { Card } from '../../ui/Card';
import { roomViewMatchesSession } from '../../v3/session';
import {
  canonicalRoomPath,
  normalizeRoomCode,
  requestedRoomView,
  roomJoinPath,
  roomPath,
} from './roomRouting';

/**
 * Protect every room child route with the server-projected RoomView. A child
 * path is only an intent; it never grants player, spectator, or omniscient
 * access by itself.
 */
export function RoomRouteGuard() {
  const { roomCode: rawRoomCode } = useParams();
  const location = useLocation();
  const code = normalizeRoomCode(rawRoomCode);
  const connected = useV3Store((state) => state.connected);
  const authorityStatus = useV3Store((state) => state.authorityStatus);
  const recovering = useV3Store((state) => state.recovering);
  const session = useV3Store((state) => state.session);
  const room = useV3Store((state) => state.room);
  const error = useV3Store((state) => state.error);
  const resumeSession = useV3Store((state) => state.resumeSession);

  if (!code) return <Navigate to="/lobby" replace />;

  if (rawRoomCode !== code) {
    const requested = requestedRoomView(location.pathname);
    return (
      <Navigate
        to={roomPath(code, requested ?? undefined)}
        replace
      />
    );
  }

  const waitingForAuthority =
    authorityStatus === 'resolving' ||
    recovering ||
    (Boolean(session) && !room) ||
    // A transient transport failure must not turn a still-valid durable
    // identity into the join form. `clearAuthority` is the only path that
    // removes the session for a definitive auth/room failure.
    (Boolean(session) && authorityStatus === 'error');

  if (waitingForAuthority) {
    return (
      <AppShell title="正在恢复房间" eyebrow="房间入口" connected={connected}>
        <Card className="v3-empty-state" aria-live="polite">
          <strong>正在核对房间权限</strong>
          <span>{error ?? '请稍候，页面会自动进入当前允许的视图。'}</span>
          {authorityStatus === 'error' ? (
            <button type="button" onClick={() => { void resumeSession(); }}>
              重新连接
            </button>
          ) : null}
        </Card>
      </AppShell>
    );
  }

  if (
    authorityStatus !== 'authorized' ||
    !session ||
    !room ||
    room.code !== code ||
    !roomViewMatchesSession(room, session)
  ) {
    return <Navigate to={roomJoinPath(code)} replace />;
  }

  const requested = requestedRoomView(location.pathname);
  const destination = canonicalRoomPath(room);
  if (requested === null || destination !== location.pathname) {
    return <Navigate to={destination} replace />;
  }

  return <Outlet />;
}
