import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { RoomLayout } from '../features/room-shell/RoomLayout';
import { useV3Store } from '../stores/v3Store';
import { NotFoundPage } from './routes/NotFoundPage';
import { RoomResolverPage } from './routes/RoomResolverPage';
import { RoomRouteGuard } from './routes/RoomRouteGuard';
import { normalizeRoomCode, roomPath } from './routes/roomRouting';

const LobbyPage = lazy(() => import('../pages/v3/LobbyPage').then(({ LobbyPage: page }) => ({ default: page })));
const JoinRoomPage = lazy(() => import('../features/room-join/JoinRoomPage').then(({ JoinRoomPage: page }) => ({ default: page })));
const SettingsPage = lazy(() => import('../pages/v3/SettingsPage').then(({ SettingsPage: page }) => ({ default: page })));
const RoomWizardPage = lazy(() => import('../features/room-wizard').then(({ RoomWizardPage: page }) => ({ default: page })));
const WaitingRoomPage = lazy(() => import('../features/waiting-room').then(({ WaitingRoomPage: page }) => ({ default: page })));
const GamePage = lazy(() => import('../pages/v3/GamePage').then(({ GamePage: page }) => ({ default: page })));
const SpectatePage = lazy(() => import('../pages/v3/SpectatePage').then(({ SpectatePage: page }) => ({ default: page })));
const MonitorPage = lazy(() => import('../pages/v3/MonitorPage').then(({ MonitorPage: page }) => ({ default: page })));
const RoomResultPage = lazy(() => import('../features/room-shell/RoomResultPage').then(({ RoomResultPage: page }) => ({ default: page })));

function RouteLoading() {
  return (
    <main className="v3-route-loading" role="status" aria-live="polite" aria-busy="true">
      <span>正在载入页面</span>
    </main>
  );
}

function LegacyRoomRedirect() {
  const { roomCode } = useParams();
  return <Navigate to={roomPath(normalizeRoomCode(roomCode))} replace />;
}

/** Compatibility for the old session-based top-level match links. */
function LegacyActiveRoomRedirect() {
  const roomCode = useV3Store((state) => state.session?.roomCode);
  return (
    <Navigate
      to={roomCode ? roomPath(roomCode) : '/lobby'}
      replace
    />
  );
}

/** Route table kept in a component so it can be mounted by BrowserRouter or tests. */
export function AppRouter() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <Routes>
      <Route path="/" element={<Navigate to="/lobby" replace />} />
      <Route path="/lobby" element={<LobbyPage />} />
      <Route path="/settings" element={<SettingsPage />} />

      {/* M8 owns the four deep-linkable creation steps. */}
      <Route path="/rooms/join" element={<JoinRoomPage />} />
      <Route path="/rooms/new">
        <Route index element={<Navigate to="/rooms/new/players" replace />} />
        <Route path=":step" element={<RoomWizardPage />} />
      </Route>

      <Route path="/rooms/:roomCode">
        <Route index element={<RoomResolverPage />} />
        <Route element={<RoomRouteGuard />}>
          <Route element={<RoomLayout />}>
            <Route path="waiting" element={<WaitingRoomPage />} />
            <Route path="play" element={<GamePage />} />
            <Route path="watch" element={<SpectatePage />} />
            <Route path="monitor" element={<MonitorPage />} />
            <Route path="result" element={<RoomResultPage />} />
          </Route>
        </Route>
      </Route>

      {/* Old URLs never render a page and never carry credentials forward. */}
      <Route path="/room/:roomCode/*" element={<LegacyRoomRedirect />} />
      <Route path="/game" element={<LegacyActiveRoomRedirect />} />
      <Route path="/spectate" element={<LegacyActiveRoomRedirect />} />
      <Route path="/monitor" element={<LegacyActiveRoomRedirect />} />

      <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
