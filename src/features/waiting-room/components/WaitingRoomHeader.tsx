import { Check, Copy, Users, Wifi } from 'lucide-react';
import type { RoomViewV31 } from '../../../../shared/roomContract';
import { roomModeLabel } from '../../../v3/presentation';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Status } from '../../../ui/Status';
import { WAITING_STATUS_LABELS } from '../selectors';

interface WaitingRoomHeaderProps {
  room: RoomViewV31;
  connected: boolean;
  canCopyInvite: boolean;
  copied: boolean;
  onCopyInvite: () => void;
}

export function WaitingRoomHeader({
  room,
  connected,
  canCopyInvite,
  copied,
  onCopyInvite,
}: WaitingRoomHeaderProps) {
  const occupiedPlayerSeats = room.members.filter(
    (member) => member.kind === 'player',
  ).length;

  return (
    <Card className="waiting-room__header-card" aria-labelledby="waiting-room-title">
      <div className="waiting-room__header-main">
        <div>
          <span className="waiting-room__eyebrow">{roomModeLabel(room.config.mode)}</span>
          <h1 id="waiting-room-title">{room.name}</h1>
          <p>成员、席位和准备状态会实时更新。</p>
        </div>
        <Badge tone={room.status === 'starting' ? 'purple' : 'gold'}>
          {WAITING_STATUS_LABELS[room.status]}
        </Badge>
      </div>

      <div className="waiting-room__header-meta">
        <span className="waiting-room__meta-item">
          <Users size={17} aria-hidden="true" />
          <strong>{occupiedPlayerSeats} / {room.config.maxPlayers}</strong>
          <span>玩家席已入座</span>
        </span>
        <span className="waiting-room__meta-item">
          <span className="waiting-room__meta-label">观战</span>
          <strong>{room.counts.spectators}</strong>
          <span>人</span>
        </span>
        <span className="waiting-room__meta-item waiting-room__room-code">
          <span className="waiting-room__meta-label">房间码</span>
          <strong className="v3-numeric">{room.code}</strong>
        </span>
        <Status
          tone={connected ? 'success' : 'warning'}
          icon={<Wifi size={15} aria-hidden="true" />}
          label={connected ? '实时连接正常' : '正在重新连接'}
        />
        {canCopyInvite ? (
          <Button
            variant="secondary"
            onClick={onCopyInvite}
            aria-label="复制邀请信息"
          >
            {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            {copied ? '已复制' : '复制邀请'}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
