import { Check, Clock3, Eye, LoaderCircle } from 'lucide-react';
import type { RoomMemberViewV31, RoomViewV31 } from '../../../../shared/roomContract';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Status } from '../../../ui/Status';
import { isActionAllowed, memberReadyLabel } from '../selectors';

interface SelfReadyCardProps {
  room: RoomViewV31;
  member: RoomMemberViewV31 | undefined;
  pending: boolean;
  locked: boolean;
  showAction?: boolean;
  onSetReady: (ready: boolean) => void;
}

export function SelfReadyCard({
  room,
  member,
  pending,
  locked,
  showAction = true,
  onSetReady,
}: SelfReadyCardProps) {
  const isPlayer = room.viewer.kind === 'player' && member?.kind === 'player';
  const canSetReady = isPlayer && isActionAllowed(room, 'set_ready');
  const ready = member?.ready === true;

  return (
    <Card className="waiting-room__self-ready" aria-labelledby="self-ready-title">
      <div className="waiting-room__section-heading">
        <div className="waiting-room__section-icon" aria-hidden="true">
          {isPlayer ? <Check size={20} /> : <Eye size={20} />}
        </div>
        <div>
          <span className="waiting-room__eyebrow">你的状态</span>
          <h2 id="self-ready-title">{isPlayer ? '准备开局' : '观战席'}</h2>
        </div>
      </div>

      {isPlayer && member ? (
        <div className="waiting-room__self-ready-body">
          <Status
            tone={ready ? 'success' : member.connected ? 'warning' : 'danger'}
            label={pending ? '正在提交准备状态…' : memberReadyLabel(member)}
          />
          {showAction && canSetReady ? (
            <Button
              variant={ready ? 'secondary' : 'primary'}
              size="action"
              disabled={pending || locked}
              onClick={() => onSetReady(!ready)}
            >
              {pending ? <LoaderCircle className="waiting-room__spin" size={17} aria-hidden="true" /> : null}
              {ready ? '取消准备' : '准备开局'}
            </Button>
          ) : (
            <span className="waiting-room__muted-action">
              {!showAction && room.status === 'ready_check'
                ? '请在上方开局流程中确认准备'
                : room.status === 'waiting'
                  ? '请修改并保存房间设置以进入准备阶段'
                  : '当前暂不能修改准备状态'}
            </span>
          )}
        </div>
      ) : (
        <div className="waiting-room__self-ready-body">
          <Status tone="info" icon={<Eye size={15} />} label="观战者不参与准备" />
          <span className="waiting-room__muted-action">
            你可以关注房间状态，不能占用玩家席或提交准备。
          </span>
        </div>
      )}

      {room.status === 'starting' ? (
        <p className="waiting-room__transition-note">
          <Clock3 size={15} aria-hidden="true" /> 正在建立对局，操作已锁定。
        </p>
      ) : null}
    </Card>
  );
}
