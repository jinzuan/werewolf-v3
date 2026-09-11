import { Check, CircleHelp, Copy, Home, RefreshCw, Settings, Wifi } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { copyText } from '../../lib/copyText';
import { useV3Store } from '../../stores/v3Store';
import { useRoomShell } from './RoomShellContext';
import {
  roomStatusLabel,
  type RoomViewSegment,
} from '../../app/routes/roomRouting';
import type { TopStatusBarProps } from '../../components/shell/TopStatusBar';
import { ProgressBar } from '../../ui/ProgressBar';
import { Modal } from '../../ui/Modal';

const viewerLabel = (kind: 'player' | 'spectator', omniscient: boolean): string => {
  if (kind === 'player') return '玩家视角';
  return omniscient ? '全知观战' : '公开观战';
};

const viewLabel: Record<RoomViewSegment, string> = {
  waiting: '等待房',
  play: '玩家对局',
  watch: '公开观战',
  monitor: '全知监控',
  result: '结果与复盘',
};

export interface RoomHeaderProps extends TopStatusBarProps {
  children?: ReactNode;
}

/** Public room identity/status header shared by waiting, match and watch views. */
export function RoomHeader({ children, ...status }: RoomHeaderProps) {
  const room = useV3Store((state) => state.room);
  const session = useV3Store((state) => state.session);
  const leaveRoomMutation = useV3Store((state) => state.leaveRoomMutation);
  const syncStatus = useV3Store((state) => state.syncStatus);
  const recovering = useV3Store((state) => state.recovering);
  const { scene } = useRoomShell();
  const navigate = useNavigate();
  const [copyState, setCopyState] = useState<'idle' | 'code'>('idle');
  const [rulesOpen, setRulesOpen] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  if (!room || !session) {
    return null;
  }

  const requestedTitle = status.title === room.code ? undefined : status.title;
  const segment: RoomViewSegment = status.title === '公开观战'
    ? 'watch'
    : status.title === '对局监控'
      ? 'monitor'
      : room.status === 'ended'
        ? 'result'
        : room.status === 'playing'
          ? 'play'
          : 'waiting';

  const compactRoomStatus = room.status === 'waiting'
    ? '等待'
    : room.status === 'playing'
      ? '对局'
      : '结束';
  const compactPhase = status.phase
    ?.replace(/^第\s*(\d+)\s*(天|夜)\s*·\s*/u, '第$1$2·')
    .replace(/（第\s*(\d+)\/(\d+)\s*轮）/u, ' $1/$2轮');
  const rememberCopy = (kind: 'code') => {
    setCopyState(kind);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyState('idle'), 2_000);
  };
  const copyCode = async () => {
    try {
      await copyText(room.code);
      rememberCopy('code');
    } catch {
      setCopyState('idle');
    }
  };
  const handleHomeClick = async (event: MouseEvent<HTMLAnchorElement>): Promise<void> => {
    if (room.status !== 'waiting' && room.status !== 'ready_check') return;
    event.preventDefault();
    await leaveRoomMutation();
    navigate('/lobby', { replace: true });
  };
  return (
    <>
      <header
        className="v3-room-header"
        data-room-view={segment}
        data-scene={scene}
        data-glass-role="navigation"
        data-glass-priority="critical"
      >
      <div className="v3-room-header__primary">
        <Link className="v3-button v3-button--quiet v3-room-header__home" data-glass-role="control" data-glass-motion="control" to="/lobby" onClick={(event) => { void handleHomeClick(event); }}>
          <Home size={16} /><span>返回大厅</span>
        </Link>
        <div className="v3-room-header__code-group">
          <Button variant="quiet" className="v3-room-header__code" onClick={() => void copyCode()} aria-label={`复制房间码 ${room.code}`} title="点击复制房间码">
            <span>房间码</span><strong className="v3-numeric">{room.code}</strong>
            {copyState === 'code' ? <Check size={16} /> : <Copy size={16} />}
            <span>{copyState === 'code' ? '已复制' : '点击复制'}</span>
          </Button>
        </div>
      </div>
      <div className="v3-room-header__identity">
        <span>{requestedTitle ?? viewLabel[segment]}</span>
        <strong>{room.name}</strong>
      </div>
      <div className="v3-room-header__actions">
        <div className="v3-room-header__status">
          <Badge tone="info" className="v3-room-header__room-state" title={`房间状态：${roomStatusLabel(room.status)}`}>
            <span className="v3-room-header__room-state-full">{roomStatusLabel(room.status)}</span>
            <span className="v3-room-header__room-state-compact">{compactRoomStatus}</span>
          </Badge>
          <Badge className="v3-room-header__connection" tone={status.connected ? 'success' : 'warning'}>
            <Wifi size={13} /><span>{status.connected ? '已连接' : '重连中'}</span>
          </Badge>
          <Badge
            className="v3-room-header__sync"
            tone={syncStatus === 'error' ? 'danger' : syncStatus === 'synced' ? 'success' : 'warning'}
          >
            <RefreshCw size={13} /><span>{recovering || syncStatus === 'syncing' ? '同步中' : syncStatus === 'error' ? '同步异常' : '已同步'}</span>
          </Badge>
          {status.phase ? (
            <Badge tone="warning" className="v3-room-header__phase" title={`当前阶段：${status.phase}`}>
              <span className="v3-room-header__phase-full">{status.phase}</span>
              <span className="v3-room-header__phase-compact">{compactPhase}</span>
            </Badge>
          ) : null}
          <Badge className="v3-room-header__timer" tone="info">
            <span className="v3-room-header__countdown">{status.countdown ?? '实时'}</span>
          </Badge>
          <span className="v3-room-header__viewer">{viewerLabel(room.viewer.kind, room.viewer.omniscient)}</span>
        </div>
        <Button variant="icon" aria-label="查看完整规则" title="帮助" onClick={() => setRulesOpen(true)}>
          <CircleHelp size={18} />
        </Button>
        <Link className="v3-button v3-button--icon v3-button--default" data-glass-role="control" data-glass-motion="control" to="/settings" aria-label="打开设置" title="设置">
          <Settings size={18} />
        </Link>
        {children}
      </div>
      {typeof status.progress === 'number' ? (
        <div className="v3-room-header__progress">
          <ProgressBar value={status.progress} label={`${status.phase ?? '当前'}阶段进度`} />
        </div>
      ) : null}
      </header>
      <Modal
        open={rulesOpen}
        title="查看完整规则"
        context={`当前房间：${room.name}`}
        onClose={() => setRulesOpen(false)}
      >
        <div className="v3-rule-dialog">
          <p>身份、夜间行动、发言队列和投票都以服务端当前阶段与合法目标为准。</p>
          <ul>
            <li>重连或同步期间请等待状态恢复，操作按钮会暂时禁用。</li>
            <li>你只会看到当前玩家或观战权限允许的事件。</li>
          </ul>
        </div>
      </Modal>
    </>
  );
}
