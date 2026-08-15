import { AlertOctagon, ArrowRightLeft, LogOut, Play, RotateCcw, Settings2, ShieldAlert, UserPlus } from 'lucide-react';
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
import { isActionAllowed } from '../selectors';

interface RoomActionsProps {
  room: RoomViewV31;
  currentMember: RoomMemberViewV31 | undefined;
  pendingAction: AllowedRoomAction | null;
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
  const can = (action: AllowedRoomAction) => isActionAllowed(room, action);
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

      <div className="waiting-room__action-list">
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

        {isHost && can('begin_ready_check') ? (
          <Button
            variant="primary"
            size="action"
            disabled={locked || busy('begin_ready_check')}
            onClick={onBeginReadyCheck}
          >
            <Play size={17} aria-hidden="true" />
            {busy('begin_ready_check') ? '正在开始准备…' : '开始准备'}
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

        {isHost && can('start_game') ? (
          <Button
            variant="primary"
            size="action"
            disabled={locked || busy('start_game')}
            onClick={onStartGame}
          >
            <Play size={18} aria-hidden="true" />
            {busy('start_game') ? '正在开局…' : '开始对局'}
          </Button>
        ) : isHost && room.status === 'ready_check' ? (
          <p className="waiting-room__action-hint">
            开局按钮会在所有检查通过后出现。
          </p>
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
