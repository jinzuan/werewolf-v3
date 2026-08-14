import { CircleHelp, Settings, Wifi } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { ProgressBar } from '../../ui/ProgressBar';

interface TopStatusBarProps {
  eyebrow?: string;
  title: string;
  phase?: string;
  countdown?: string;
  live?: boolean;
  progress?: number;
  connected?: boolean;
}

export function TopStatusBar({
  eyebrow = '狼人杀 V3',
  title,
  phase,
  countdown,
  live = false,
  progress = 64,
  connected = false,
}: TopStatusBarProps) {
  return (
    <header className="v3-topbar">
      <div className="v3-topbar__identity">
        <span className="v3-topbar__mark" aria-hidden="true">狼</span>
        <div>
          <span>{eyebrow}</span>
          <strong>{title}</strong>
        </div>
      </div>

      {phase ? (
        <div className="v3-phase-track">
          <div className="v3-phase-track__meta">
            <Badge tone="purple">{phase}</Badge>
            {countdown ? <strong className="v3-numeric">{countdown}</strong> : null}
            {live ? <Badge tone="danger">LIVE</Badge> : null}
          </div>
          <ProgressBar value={progress} label={`${phase}阶段进度`} />
        </div>
      ) : null}

      <div className="v3-topbar__actions">
        <Badge tone={connected ? 'success' : 'warning'}>
          <Wifi size={13} />{connected ? '已连接' : '连接中'}
        </Badge>
        <Button variant="icon" aria-label="查看规则" title="规则">
          <CircleHelp size={18} />
        </Button>
        <Link className="v3-button v3-button--icon v3-button--default" to="/settings" aria-label="打开设置" title="设置">
          <Settings size={18} />
        </Link>
      </div>
    </header>
  );
}
