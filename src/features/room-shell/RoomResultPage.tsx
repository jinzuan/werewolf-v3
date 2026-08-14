import { Link } from 'react-router-dom';
import { AppShell } from '../../components/shell/AppShell';
import { useV3Store } from '../../stores/v3Store';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';

/** Small stable result entry point until the match feature owns the full page. */
export function RoomResultPage() {
  const connected = useV3Store((state) => state.connected);
  const room = useV3Store((state) => state.room);

  return (
    <AppShell
      title="结果与复盘"
      eyebrow={room?.name ?? '房间'}
      connected={connected}
    >
      <Card className="v3-empty-state">
        <strong>本局已经结束</strong>
        <span>结果入口已恢复，完整复盘内容将在这里展示。</span>
        <Link to="/lobby">
          <Button>返回大厅</Button>
        </Link>
      </Card>
    </AppShell>
  );
}

