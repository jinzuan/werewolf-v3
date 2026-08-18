import { CircleHelp, Settings, Wifi } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { phaseAssetMap, roleAssetMap } from '../../ui/assetRegistry';
import { Modal } from '../../ui/Modal';
import { ROOM_SCENE_LABELS, type RoomScene } from '../../features/room-shell/scene';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { ProgressBar } from '../../ui/ProgressBar';

export interface TopStatusBarProps {
  eyebrow?: string;
  title: string;
  phase?: string;
  countdown?: string;
  live?: boolean;
  progress?: number;
  connected?: boolean;
  scene?: RoomScene;
}

export function TopStatusBar({
  eyebrow = '狼人杀·月光森林',
  title,
  phase,
  countdown,
  live = false,
  progress,
  connected = false,
  scene = 'lobby',
}: TopStatusBarProps) {
  const [rulesOpen, setRulesOpen] = useState(false);
  const phaseAsset = phaseAssetMap[scene];
  return (
    <header className="v3-topbar" data-scene={scene}>
      <div className="v3-topbar__identity">
        <span className="v3-topbar__mark">
          <img src={roleAssetMap.wolf.src} alt="" aria-hidden="true" />
        </span>
        <div>
          <span>{eyebrow}</span>
          <strong>{title}</strong>
        </div>
      </div>

      {phase ? (
        <div className="v3-phase-track">
          <div className="v3-phase-track__meta">
            <img className="v3-phase-track__moon" src={phaseAsset.src} alt={phaseAsset.label} />
            <span className="v3-phase-track__scene-label">{ROOM_SCENE_LABELS[scene]}</span>
            <Badge tone="purple">{phase}</Badge>
            {countdown ? <strong className="v3-numeric">{countdown}</strong> : null}
            {live ? <Badge tone="danger">实时</Badge> : null}
          </div>
            {typeof progress === 'number' ? (
              <ProgressBar value={progress} label={`${phase}阶段进度`} />
            ) : null}
        </div>
      ) : null}

      <div className="v3-topbar__actions">
        <Badge tone={connected ? 'success' : 'warning'}>
          <Wifi size={13} />{connected ? '已连接' : '连接中'}
        </Badge>
        <Button variant="icon" aria-label="查看完整规则" aria-haspopup="dialog" title="规则" onClick={() => setRulesOpen(true)}>
          <CircleHelp size={18} />
        </Button>
        <Link className="v3-button v3-button--icon v3-button--default v3-topbar__settings-link" to="/settings" aria-label="打开设置" title="设置">
          <Settings size={18} />
        </Link>
      </div>
      <Modal
        open={rulesOpen}
        title="查看完整规则"
        context="当前房间使用的规则说明"
        onClose={() => setRulesOpen(false)}
      >
        <div className="v3-rule-dialog">
          <p>身份会在开局后私密发放。夜间行动、白天发言和投票都由房间规则统一裁定。</p>
          <ul>
            <li>请先入座并完成准备，房主会在检查通过后开始对局。</li>
            <li>你只能看到当前观看权限允许的信息。</li>
            <li>连接中断时请等待恢复，页面会自动同步最新状态。</li>
          </ul>
        </div>
      </Modal>
    </header>
  );
}
