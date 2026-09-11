import { CheckCircle, LogOut, Play, RotateCcw, Settings2, ShieldAlert } from 'lucide-react';
import type {
  AllowedRoomAction,
  RoomMemberViewV31,
  RoomViewV31,
} from '../../../../shared/roomContract';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { isActionAllowed, startCheckReason } from '../selectors';

interface RoomActionsProps {
  room: RoomViewV31;
  currentMember: RoomMemberViewV31 | undefined;
  pendingAction: AllowedRoomAction | null;
  onSetReady: (ready: boolean) => void;
  onBeginReadyCheck: () => void;
  onCancelReadyCheck: () => void;
  onStartGame: () => void;
  onOpenSettings: () => void;
  onLeave: () => void;
}

export function RoomActions({
  room,
  currentMember,
  pendingAction,
  onSetReady,
  onBeginReadyCheck,
  onCancelReadyCheck,
  onStartGame,
  onOpenSettings,
  onLeave,
}: RoomActionsProps) {
  const locked = room.status === 'starting';
  const isHost = currentMember?.isHost === true;
  const isPlayer = room.viewer.kind === 'player' && currentMember?.kind === 'player';
  const ready = currentMember?.ready === true;
  const can = (action: AllowedRoomAction) => isActionAllowed(room, action);
  const failedChecks = room.startCheck.items
    .filter((item) => !item.passed);
  const playerMembers = room.members.filter((member) => member.kind === 'player');
  const readyCount = playerMembers.filter((member) => member.ready).length;
  const blockedReasonFor = (): string => {
    return failedChecks.length
      ? `暂不可用：${failedChecks.map(startCheckReason).join('；')}`
      : '当前阶段暂不能执行该操作。';
  };
  const busy = (action: AllowedRoomAction): boolean => pendingAction === action;

  return (
    <Card className="waiting-room__actions" aria-labelledby="room-actions-title">
      <div className="waiting-room__section-heading">
        <div className="waiting-room__section-icon" aria-hidden="true">
          <ShieldAlert size={20} />
        </div>
        <div>
          <span className="waiting-room__eyebrow">现在要做什么</span>
          <h2 id="room-actions-title">当前操作</h2>
        </div>
        {isHost ? <Badge tone="gold">房主</Badge> : null}
      </div>

      <div className="waiting-room__action-flow" aria-label="开局流程">
        <span className="waiting-room__eyebrow">开局流程</span>
        <div className="waiting-room__action-list waiting-room__action-list--flow">
        {isPlayer && room.status === 'ready_check' && can('set_ready') ? (
          <Button
            className="waiting-room__ready-action"
            variant={ready ? 'secondary' : 'primary'}
            size="action"
            disabled={locked || busy('set_ready')}
            onClick={() => onSetReady(!ready)}
          >
            <CheckCircle size={17} aria-hidden="true" />
            <span className="waiting-room__action-label">
              {busy('set_ready') ? '正在提交准备…' : ready ? '取消准备' : '确认准备'}
            </span>
          </Button>
        ) : null}

        {isHost && room.status === 'ready_check' ? (
          <div className="waiting-room__start-control">
            <Button
              className="waiting-room__start-action"
              variant="primary"
              size="action"
              disabled={locked || busy('start_game') || !can('start_game')}
              aria-describedby={!can('start_game') ? 'start-game-reason' : undefined}
              onClick={onStartGame}
            >
              <Play size={18} aria-hidden="true" />
              {busy('start_game') ? '正在开局…' : '开始游戏'}
            </Button>
            <div className="waiting-room__start-meta">
              <span className="waiting-room__ready-count">
                准备 {readyCount} / {playerMembers.length}
              </span>
              {!can('start_game') ? (
                <p id="start-game-reason" className="waiting-room__action-blocker" role="status">
                  <span>{blockedReasonFor()}</span>
                </p>
              ) : <span className="waiting-room__start-ready">开局条件已满足</span>}
            </div>
          </div>
        ) : null}

        {isHost && room.status === 'waiting' && can('begin_ready_check') ? (
          <Button
            variant="primary"
            size="action"
            disabled={locked || busy('begin_ready_check')}
            onClick={onBeginReadyCheck}
          >
            <CheckCircle size={17} aria-hidden="true" />
            {busy('begin_ready_check') ? '正在进入准备…' : '开始准备'}
          </Button>
        ) : null}
        </div>
      </div>

      <div className="waiting-room__action-list waiting-room__action-list--secondary">
        {isHost && can('cancel_ready_check') ? (
          <Button
            variant="secondary"
            disabled={locked || busy('cancel_ready_check')}
            onClick={onCancelReadyCheck}
          >
            <RotateCcw size={17} aria-hidden="true" />
            {busy('cancel_ready_check') ? '正在返回设置…' : '返回设置'}
          </Button>
        ) : null}

        {isHost && can('update_config') ? (
          <Button
            variant="secondary"
            disabled={locked || busy('update_config')}
            onClick={onOpenSettings}
          >
            <Settings2 size={17} aria-hidden="true" />
            房间设置
          </Button>
        ) : null}

        {can('leave') ? (
          <Button
            variant="quiet"
            disabled={locked || busy('leave')}
            onClick={onLeave}
          >
            <LogOut size={17} aria-hidden="true" />
            {busy('leave') ? '正在返回大厅…' : '返回大厅'}
          </Button>
        ) : null}
      </div>

      {locked ? (
        <p className="waiting-room__transition-note">
          <ShieldAlert size={15} aria-hidden="true" /> 正在开局，所有房间按钮已锁定。
        </p>
      ) : null}

    </Card>
  );
}
