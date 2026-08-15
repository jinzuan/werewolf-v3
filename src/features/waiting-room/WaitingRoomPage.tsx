import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  AllowedRoomAction,
  RoomConfigView,
  RoomMutationCommand,
  StartCheckItem,
} from '../../../shared/protocol';
import { AppShell } from '../../components/shell/AppShell';
import { sendV3RoomCommand } from '../../net/v3Socket';
import { useV3Store } from '../../stores/v3Store';
import { getErrorMessage } from '../../v3/presentation';
import { Card } from '../../ui/Card';
import { RoomActions } from './components/RoomActions';
import { RoomConfigEditor } from './components/RoomConfigEditor';
import { RoomConfigSummary } from './components/RoomConfigSummary';
import { SelfReadyCard } from './components/SelfReadyCard';
import { PlayerSeatGrid } from './components/PlayerSeatGrid';
import { SpectatorList } from './components/SpectatorList';
import { StartCheckPanel } from './components/StartCheckPanel';
import { WaitingRoomHeader } from './components/WaitingRoomHeader';
import {
  isActionAllowed,
  isWaitingRoomStatus,
  WAITING_STATUS_LABELS,
} from './selectors';
import './waiting-room.css';

type DirectRoomAction = Extract<
  AllowedRoomAction,
  'update_config' | 'transfer_host' | 'dissolve' | 'leave'
>;

const pendingActionForCommand = (
  command: string | null,
): AllowedRoomAction | null => {
  switch (command) {
    case 'room.begin_ready_check':
      return 'begin_ready_check';
    case 'room.cancel_ready_check':
      return 'cancel_ready_check';
    case 'room.ready':
      return 'set_ready';
    case 'room.start_game':
      return 'start_game';
    default:
      return null;
  }
};

const scrollToCheckTarget = (item: StartCheckItem): void => {
  const targetId = item.key === 'config_valid' ||
    item.key === 'role_count' ||
    item.key === 'ai_fill' ||
    item.key === 'ruleset_available'
    ? 'room-config-title'
    : 'player-seats-title';
  document.getElementById(targetId)?.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  });
};

export function WaitingRoomPage() {
  const navigate = useNavigate();
  const connected = useV3Store((state) => state.connected);
  const loading = useV3Store((state) => state.loading);
  const storeError = useV3Store((state) => state.error);
  const pendingRoomCommand = useV3Store((state) => state.pendingRoomCommand);
  const room = useV3Store((state) => state.room);
  const session = useV3Store((state) => state.session);
  const beginReadyCheck = useV3Store((state) => state.beginReadyCheck);
  const cancelReadyCheck = useV3Store((state) => state.cancelReadyCheck);
  const setReady = useV3Store((state) => state.setReady);
  const startGame = useV3Store((state) => state.startGame);
  const refreshRoom = useV3Store((state) => state.refreshRoom);
  const clearAuthority = useV3Store((state) => state.clearAuthority);
  const [directPending, setDirectPending] = useState<DirectRoomAction | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [configEditorOpen, setConfigEditorOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  const runDirectMutation = useCallback(async (
    action: DirectRoomAction,
    command: RoomMutationCommand,
  ): Promise<boolean> => {
    const currentRoom = useV3Store.getState().room;
    const currentSession = useV3Store.getState().session;
    if (
      !currentRoom ||
      !currentSession ||
      currentRoom.status === 'starting' ||
      !isActionAllowed(currentRoom, action)
    ) {
      return false;
    }

    setDirectPending(action);
    setPageError(null);
    const response = await sendV3RoomCommand(
      currentSession.actorId,
      currentSession.roomId,
      currentRoom.roomRevision,
      command,
    );

    if (response.ok === false) {
      await refreshRoom();
      setPageError(getErrorMessage(response.code));
      setDirectPending(null);
      return false;
    }

    if (action === 'leave' || action === 'dissolve') {
      clearAuthority();
      navigate('/lobby', { replace: true });
    } else {
      await refreshRoom();
    }
    setDirectPending(null);
    return true;
  }, [clearAuthority, navigate, refreshRoom]);

  const onCopyInvite = useCallback(async () => {
    if (!room || !session || !isActionAllowed(room, 'invite')) return;
    const joinToken = session.credentials.joinToken;
    if (!joinToken || !navigator.clipboard?.writeText) {
      setPageError('当前浏览器暂不支持复制邀请信息。');
      return;
    }
    try {
      await navigator.clipboard.writeText(
        `${room.name} 邀请你加入狼人杀房间\n房间码：${room.code}\n邀请口令：${joinToken}`,
      );
      setCopied(true);
      setPageError(null);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 2_400);
    } catch {
      setPageError('复制邀请信息失败，请稍后重试。');
    }
  }, [room, session]);

  if (!room || !session || !isWaitingRoomStatus(room.status)) return null;

  const currentMember = room.members.find(
    (member) => member.id === room.viewer.actorId,
  );
  const isHost = currentMember?.isHost === true;
  const locked = room.status === 'starting';
  const canCopyInvite = !locked && isHost && Boolean(session.credentials.joinToken) && isActionAllowed(room, 'invite');
  const pendingAction = directPending ?? pendingActionForCommand(pendingRoomCommand);
  const error = pageError ?? storeError;

  const begin = () => {
    setPageError(null);
    void beginReadyCheck();
  };
  const cancel = () => {
    setPageError(null);
    void cancelReadyCheck();
  };
  const ready = (value: boolean) => {
    setPageError(null);
    void setReady(value);
  };
  const start = () => {
    setPageError(null);
    void startGame();
  };
  const updateConfig = (config: RoomConfigView) => {
    void runDirectMutation('update_config', {
      type: 'room.update_config',
      payload: { config },
    }).then((success) => {
      if (success) setConfigEditorOpen(false);
    });
  };
  const transferHost = (memberId: string) => {
    void runDirectMutation('transfer_host', {
      type: 'room.transfer_host',
      payload: { targetMemberId: memberId },
    });
  };
  const dissolve = () => {
    void runDirectMutation('dissolve', {
      type: 'room.dissolve',
      payload: { confirm: true },
    });
  };
  const leave = () => {
    void runDirectMutation('leave', {
      type: 'room.leave',
      payload: {},
    });
  };
  const resolveCheckAction = (action: Extract<AllowedRoomAction, 'invite' | 'update_config'>) => {
    if (action === 'invite') void onCopyInvite();
    else setConfigEditorOpen(true);
  };

  return (
    <AppShell
      title="等待房"
      eyebrow={room.name}
      phase={WAITING_STATUS_LABELS[room.status]}
      connected={connected}
    >
      <div className="waiting-room" data-room-status={room.status}>
        <WaitingRoomHeader
          room={room}
          connected={connected}
          canCopyInvite={canCopyInvite}
          copied={copied}
          onCopyInvite={() => void onCopyInvite()}
        />

        {error ? (
          <div className="v3-alert v3-alert--error waiting-room__error" role="alert">
            {error}
          </div>
        ) : null}

        <SelfReadyCard
          room={room}
          member={currentMember}
          pending={pendingAction === 'set_ready' || pendingRoomCommand === 'room.ready'}
          locked={locked || loading}
          onSetReady={ready}
        />

        <div className="waiting-room__workspace">
          <PlayerSeatGrid room={room} />
          <StartCheckPanel
            items={room.startCheck.items}
            members={room.members}
            allowedActions={room.viewer.allowedRoomActions}
            onAction={resolveCheckAction}
            onLocate={scrollToCheckTarget}
          />
        </div>

        <SpectatorList room={room} />
        <RoomConfigSummary
          room={room}
          onUpdateConfig={() => setConfigEditorOpen(true)}
        />
        <RoomActions
          room={room}
          currentMember={currentMember}
          pendingAction={pendingAction}
          onBeginReadyCheck={begin}
          onCancelReadyCheck={cancel}
          onStartGame={start}
          onInvite={() => void onCopyInvite()}
          onUpdateConfig={() => setConfigEditorOpen(true)}
          onTransferHost={transferHost}
          onDissolve={dissolve}
          onLeave={leave}
        />

        <RoomConfigEditor
          room={room}
          open={configEditorOpen && isHost && isActionAllowed(room, 'update_config')}
          pending={directPending === 'update_config'}
          onClose={() => setConfigEditorOpen(false)}
          onSubmit={updateConfig}
        />

        <Card className="waiting-room__footer-note">
          <span>房间状态会自动同步</span>
          <span>· 刷新或重连后会恢复最新房间信息。</span>
        </Card>
      </div>
    </AppShell>
  );
}
