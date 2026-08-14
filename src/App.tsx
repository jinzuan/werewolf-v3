import { useEffect } from 'react';
import { BrowserRouter as Router, Navigate, Route, Routes } from 'react-router-dom';
import { LobbyPage } from './pages/v3/LobbyPage';
import { RoomPage } from './pages/v3/RoomPage';
import { SettingsPage } from './pages/v3/SettingsPage';
import { useV3Store } from './stores/v3Store';

function ActiveRoomRedirect() {
  const roomCode = useV3Store((state) => state.session?.roomCode);
  return <Navigate to={roomCode ? `/room/${roomCode}` : '/'} replace />;
}

export default function App() {
  const initialize = useV3Store((state) => state.initialize);

  useEffect(() => initialize(), [initialize]);

  return (
    <Router>
      <Routes>
        <Route path="/" element={<LobbyPage />} />
        <Route path="/room/:roomCode" element={<RoomPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/game" element={<ActiveRoomRedirect />} />
        <Route path="/spectate" element={<ActiveRoomRedirect />} />
        <Route path="/monitor" element={<ActiveRoomRedirect />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}
