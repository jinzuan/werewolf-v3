import { Link } from 'react-router-dom';
import { AppShell } from '../../components/shell/AppShell';
import { useV3Store } from '../../stores/v3Store';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';

export function NotFoundPage() {
  const connected = useV3Store((state) => state.connected);

  return (
    <AppShell title="页面未找到" eyebrow="狼人杀 V3" connected={connected}>
      <Card className="v3-empty-state">
        <strong>这条路还没有通往村庄</strong>
        <span>请返回大厅，重新选择一个入口。</span>
        <Link to="/lobby">
          <Button>返回大厅</Button>
        </Link>
      </Card>
    </AppShell>
  );
}

