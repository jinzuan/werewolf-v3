import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { RoomLayout } from '../features/room-shell/RoomLayout';
import { RoomResultPage } from '../features/room-shell/RoomResultPage';
import { RoomWizardPage } from '../features/room-wizard';
import { GamePage } from '../pages/v3/GamePage';
import { LobbyPage } from '../pages/v3/LobbyPage';
import { MonitorPage } from '../pages/v3/MonitorPage';
import { RoomPage } from '../pages/v3/RoomPage';
import { SettingsPage } from '../pages/v3/SettingsPage';
import { SpectatePage } from '../pages/v3/SpectatePage';
import { useV3Store } from '../stores/v3Store';
import { NotFoundPage } from './routes/NotFoundPage';
import { RoomResolverPage } from './routes/RoomResolverPage';
import { RoomRouteGuard } from './routes/RoomRouteGuard';
import { normalizeRoomCode, roomPath } from './routes/roomRouting';

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
    <Routes>
      <Route path="/" element={<Navigate to="/lobby" replace />} />
      <Route path="/lobby" element={<LobbyPage />} />
      <Route path="/settings" element={<SettingsPage />} />

      {/* M8 owns the four deep-linkable creation steps. */}
      <Route path="/rooms/join" element={<LobbyPage />} />
      <Route path="/rooms/new">
        <Route index element={<Navigate to="/rooms/new/players" replace />} />
        <Route path=":step" element={<RoomWizardPage />} />
      </Route>

      <Route path="/rooms/:roomCode">
        <Route index element={<RoomResolverPage />} />
        <Route element={<RoomRouteGuard />}>
          <Route element={<RoomLayout />}>
            <Route path="waiting" element={<RoomPage />} />
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
  );
}

