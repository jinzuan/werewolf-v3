import type { ReactNode } from 'react';
import { Badge } from '../../ui/Badge';
import { useV3Store } from '../../stores/v3Store';
import { sceneForRoom } from './scene';
import {
  roomStatusLabel,
  type RoomViewSegment,
} from '../../app/routes/roomRouting';
import {
  TopStatusBar,
  type TopStatusBarProps,
} from '../../components/shell/TopStatusBar';

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
  const snapshot = useV3Store((state) => state.snapshot);

  if (!room || !session) {
    return <TopStatusBar {...status} />;
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

  return (
    <div className="v3-room-header">
      <TopStatusBar
        {...status}
        scene={status.scene ?? sceneForRoom(room.status, snapshot?.gameState)}
        eyebrow={room.name}
        title={requestedTitle ?? viewLabel[segment]}
      />
      <div className="v3-room-header__meta" aria-label="当前房间信息">
        <span>房间码</span>
        <strong className="v3-numeric">{room.code}</strong>
        <Badge tone={room.status === 'ended' ? 'info' : 'success'}>
          {roomStatusLabel(room.status)}
        </Badge>
        <span>{viewerLabel(room.viewer.kind, room.viewer.omniscient)}</span>
        {children}
      </div>
    </div>
  );
}
