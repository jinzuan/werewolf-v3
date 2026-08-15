import { ShieldAlert } from 'lucide-react';
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { AppShell } from '../../components/shell/AppShell';
import { useV3Store } from '../../stores/v3Store';
import { Card } from '../../ui/Card';
import { GamePage } from './GamePage';
import { MonitorPage } from './MonitorPage';
import { SpectatePage } from './SpectatePage';

export function RoomPage() {
  const { roomCode = '' } = useParams();
  const connected = useV3Store((state) => state.connected);
  const room = useV3Store((state) => state.room);
  const session = useV3Store((state) => state.session);
  const leaveRoom = useV3Store((state) => state.leaveRoom);

  useEffect(() => {
    if (
      session &&
      session.roomCode !== roomCode.trim().toUpperCase()
    ) {
      leaveRoom();
    }
  }, [leaveRoom, roomCode, session]);

  if (!room || !session || room.code !== roomCode.trim().toUpperCase()) {
    return (
      <AppShell title={roomCode || '房间'} connected={connected}>
        <Card className="v3-empty-state">
          <ShieldAlert size={24} />
          <strong>当前没有该房间的有效身份</strong>
          <span>请从大厅使用房间码和邀请口令加入，或恢复已保存的身份。</span>
        </Card>
      </AppShell>
    );
  }

  if (room.viewer.kind === 'spectator') {
    return room.viewer.omniscient ? <MonitorPage /> : <SpectatePage />;
  }
  return <GamePage />;
}
