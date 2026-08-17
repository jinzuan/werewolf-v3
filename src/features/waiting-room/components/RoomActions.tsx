import { AlertOctagon, ArrowRightLeft, CheckCircle, LogOut, Play, RotateCcw, Settings2, ShieldAlert, UserPlus } from 'lucide-react';
import { useState } from 'react';
import type {
  AllowedRoomAction,
  RoomMemberViewV31,
  RoomViewV31,
} from '../../../../shared/roomContract';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Modal } from '../../../ui/Modal';
import { isActionAllowed, startCheckReason } from '../selectors';

interface RoomActionsProps {
  room: RoomViewV31;
  currentMember: RoomMemberViewV31 | undefined;
  pendingAction: AllowedRoomAction | null;
  onSetReady: (ready: boolean) => void;
  onBeginReadyCheck: () => void;
  onCancelReadyCheck: () => void;
  onStartGame: () => void;
  onInvite: () => void;
  onUpdateConfig: () => void;
  onTransferHost: (memberId: string) => void;
  onDissolve: () => void;
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
  onInvite,
  onUpdateConfig,
  onTransferHost,
  onDissolve,
  onLeave,
}: RoomActionsProps) {
  const [dangerOpen, setDangerOpen] = useState(false);
  const locked = room.status === 'starting';
  const isHost = currentMember?.isHost === true;
  const isPlayer = room.viewer.kind === 'player' && currentMember?.kind === 'player';
  const ready = currentMember?.ready === true;
  const can = (action: AllowedRoomAction) => isActionAllowed(room, action);
  const failedChecksFor = (action: 'begin_ready_check' | 'start_game') => room.startCheck.items
    .filter((item) => !item.passed)
    .filter((item) => action === 'start_game' || (
      item.key !== 'all_humans_online' && item.key !== 'all_humans_ready'
    ));
  const blockedReasonFor = (action: 'begin_ready_check' | 'start_game'): string => {
    const failedChecks = failedChecksFor(action);
    return failedChecks.length
      ? `暂不可用：${failedChecks.map(startCheckReason).join('；')}`
      : '当前阶段暂不能执行该操作。';
  };
  const transferTargets = room.members.filter(
    (member) =>
      member.kind === 'player' &&
      !member.isAI &&
      member.id !== room.viewer.actorId &&
      member.connected,
  );
  const busy = (action: AllowedRoomAction): boolean => pendingAction === action;

  return (
    <Card className="waiting-room__actions" aria-labelledby="room-actions-title">
      <div className="waiting-room__section-heading">
        <div className="waiting-room__section-icon" aria-hidden="true">
          <ShieldAlert size={20} />
        </div>
        <div>
          <span className="waiting-room__eyebrow">可用操作</span>
          <h2 id="room-actions-title">房间操作</h2>
        </div>
        {isHost ? <Badge tone="gold">房主</Badge> : null}
      </div>

      <div className="waiting-room__action-flow" aria-label="开局流程">
        <span className="waiting-room__eyebrow">开局流程</span>
        <div className="waiting-room__action-list waiting-room__action-list--flow">
        {isHost && room.status === 'waiting' ? (
          <>
            <Button
              variant="primary"
              size="action"
              disabled={locked || busy('begin_ready_check') || !can('begin_ready_check')}
              aria-describedby={!can('begin_ready_check') ? 'begin-ready-check-reason' : undefined}
              onClick={onBeginReadyCheck}
            >
              <Play size={17} aria-hidden="true" />
              {busy('begin_ready_check') ? '正在开始准备…' : '开始准备'}
            </Button>
            {!can('begin_ready_check') ? (
              <p id="begin-ready-check-reason" className="waiting-room__action-blocker" role="status">
                {blockedReasonFor('begin_ready_check')}
              </p>
            ) : null}
          </>
        ) : null}

        {isPlayer && room.status === 'ready_check' && can('set_ready') ? (
          <Button
            variant={ready ? 'secondary' : 'primary'}
            size="action"
            disabled={locked || busy('set_ready')}
            onClick={() => onSetReady(!ready)}
          >
            <CheckCircle size={17} aria-hidden="true" />
            {busy('set_ready') ? '正在提交准备…' : ready ? '取消准备' : '确认准备'}
          </Button>
        ) : null}

        {isHost && room.status === 'ready_check' ? (
          <>
            <Button
              variant="primary"
              size="action"
              disabled={locked || busy('start_game') || !can('start_game')}
              aria-describedby={!can('start_game') ? 'start-game-reason' : undefined}
              onClick={onStartGame}
            >
              <Play size={18} aria-hidden="true" />
              {busy('start_game') ? '正在开局…' : '开始游戏'}
            </Button>
            {!can('start_game') ? (
              <p id="start-game-reason" className="waiting-room__action-blocker" role="status">
                {blockedReasonFor('start_game')}
              </p>
            ) : null}
          </>
        ) : null}
        </div>
      </div>

      <div className="waiting-room__action-list waiting-room__action-list--secondary">
        {isHost && can('update_config') ? (
          <Button
            variant="secondary"
            disabled={locked || busy('update_config')}
            onClick={onUpdateConfig}
          >
            <Settings2 size={17} aria-hidden="true" />
            修改房间设置
          </Button>
        ) : null}

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

        {can('invite') ? (
          <Button
            variant="secondary"
            disabled={locked || busy('invite')}
            onClick={onInvite}
          >
            <UserPlus size={17} aria-hidden="true" />
            邀请玩家
          </Button>
        ) : null}

        {can('leave') ? (
          <Button
            variant="quiet"
            disabled={locked || busy('leave')}
            onClick={onLeave}
          >
            <LogOut size={17} aria-hidden="true" />
            {busy('leave') ? '正在离开…' : '离开房间'}
          </Button>
        ) : null}

        {isHost && (can('transfer_host') || can('dissolve')) ? (
          <Button
            variant="quiet"
            disabled={locked}
            onClick={() => setDangerOpen(true)}
          >
            <AlertOctagon size={17} aria-hidden="true" />
            更多房主操作
          </Button>
        ) : null}
      </div>

      {locked ? (
        <p className="waiting-room__transition-note">
          <ShieldAlert size={15} aria-hidden="true" /> 正在开局，所有房间按钮已锁定。
        </p>
      ) : null}

      <Modal
        open={dangerOpen}
        title="房主高级操作"
        context="这些操作会影响整个房间，请确认目标和后果。"
        onClose={() => setDangerOpen(false)}
      >
        <div className="waiting-room__danger-menu">
          {can('transfer_host') ? (
            <div>
              <h3><ArrowRightLeft size={17} aria-hidden="true" /> 转让房主</h3>
              {transferTargets.length ? transferTargets.map((member) => (
                <Button
                  key={member.id}
                  variant="secondary"
                  disabled={busy('transfer_host')}
                  onClick={() => {
                    setDangerOpen(false);
                    onTransferHost(member.id);
                  }}
                >
                  转让给 {member.name}
                </Button>
              )) : <p>暂无符合条件的在线真人玩家。</p>}
            </div>
          ) : null}
          {can('dissolve') ? (
            <div className="waiting-room__danger-block">
              <h3><AlertOctagon size={17} aria-hidden="true" /> 解散房间</h3>
              <p>房间和当前等待状态会被关闭，成员需要重新加入其他房间。</p>
              <Button
                variant="danger"
                disabled={busy('dissolve')}
                onClick={() => {
                  setDangerOpen(false);
                  onDissolve();
                }}
              >
                {busy('dissolve') ? '正在解散…' : '确认解散房间'}
              </Button>
            </div>
          ) : null}
        </div>
      </Modal>
    </Card>
  );
}
