import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { joinInviteUrl } from '../../app/routes/roomRouting';
import type {
  AllowedRoomAction,
  RoomConfigView,
  RoomAIConfigPatch,
  RoomSeatRequestView,
  StartCheckItem,
} from '../../../shared/protocol';
import { AppShell } from '../../components/shell/AppShell';
import { useV3Store } from '../../stores/v3Store';
import { Card } from '../../ui/Card';
import { Button } from '../../ui/Button';
import { Modal } from '../../ui/Modal';
import { RoomActions } from './components/RoomActions';
import { RoomConfigEditor } from './components/RoomConfigEditor';
import { RoomConfigSummary } from './components/RoomConfigSummary';
import { RoomAIConfigEditor } from './components/RoomAIConfigEditor';
import { PlayerSeatGrid } from './components/PlayerSeatGrid';
import { SpectatorList } from './components/SpectatorList';
import { StartCheckPanel } from './components/StartCheckPanel';
import { WaitingRoomHeader } from './components/WaitingRoomHeader';
import {
  isActionAllowed,
  isWaitingRoomStatus,
  selectViewerPlayerMember,
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
    case 'room.update_config':
      return 'update_config';
    case 'room.transfer_host':
      return 'transfer_host';
    case 'room.dissolve':
      return 'dissolve';
    case 'room.leave':
      return 'leave';
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
  const updateRoomConfig = useV3Store((state) => state.updateRoomConfig);
  const claimSeat = useV3Store((state) => state.claimSeat);
  const addAISeat = useV3Store((state) => state.addAISeat);
  const becomeSpectator = useV3Store((state) => state.becomeSpectator);
  const requestSeat = useV3Store((state) => state.requestSeat);
  const kickPlayer = useV3Store((state) => state.kickPlayer);
  const respondSeatRequest = useV3Store((state) => state.respondSeatRequest);
  const transferHostAction = useV3Store((state) => state.transferHost);
  const leaveRoomMutation = useV3Store((state) => state.leaveRoomMutation);
  const dissolveRoom = useV3Store((state) => state.dissolveRoom);
  const refreshRoom = useV3Store((state) => state.refreshRoom);
  const aiSummary = useV3Store((state) => state.aiConfigSummary);
  const aiConfigStatus = useV3Store((state) => state.aiConfigStatus);
  const aiConfigError = useV3Store((state) => state.aiConfigError);
  const loadAIConfig = useV3Store((state) => state.loadAIConfig);
  const updateAIConfig = useV3Store((state) => state.updateAIConfig);
  const [pageError, setPageError] = useState<string | null>(null);
  const [configEditorOpen, setConfigEditorOpen] = useState(false);
  const [aiEditorOpen, setAIEditorOpen] = useState(false);
  const [seatRequestOpen, setSeatRequestOpen] = useState(false);
  const [approvedSeatRequest, setApprovedSeatRequest] = useState<RoomSeatRequestView | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  const runDirectMutation = useCallback(async (
    action: DirectRoomAction,
    operation: () => Promise<boolean>,
  ): Promise<boolean> => {
    if (
      !room ||
      !session ||
      room.status === 'starting' ||
      !isActionAllowed(room, action)
    ) {
      return false;
    }

    setPageError(null);
    if (!await operation()) return false;

    if (action === 'leave' || action === 'dissolve') {
      navigate('/lobby', { replace: true });
    } else {
      await refreshRoom();
    }
    return true;
  }, [navigate, refreshRoom, room, session]);

  const onCopyInvite = useCallback(async () => {
    if (!room || !session || !isActionAllowed(room, 'invite')) return;
    const joinToken = session.credentials.joinToken;
    if (!joinToken || !navigator.clipboard?.writeText) {
      setPageError('当前浏览器暂不支持复制邀请信息。');
      return;
    }
    try {
      await navigator.clipboard.writeText(
        `${joinInviteUrl(window.location.origin, room.code, 'play')}\n\n房间码：${room.code}\n邀请口令：${joinToken}`,
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

  const currentMember = selectViewerPlayerMember(room);
  const isHost = currentMember?.isHost === true;
  const locked = room.status === 'starting';
  const canCopyInvite = !locked && isHost && Boolean(session.credentials.joinToken) && isActionAllowed(room, 'invite');
  const pendingAction = pendingActionForCommand(pendingRoomCommand);
  const error = pageError ?? storeError;

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
    void runDirectMutation('update_config', () => updateRoomConfig(config)).then((success) => {
      if (success) setConfigEditorOpen(false);
    });
  };
  const openAIConfigEditor = () => {
    setAIEditorOpen(true);
    void loadAIConfig();
  };
  const updateAI = (patch: RoomAIConfigPatch) => {
    void updateAIConfig(patch).then((success) => {
      if (success) setAIEditorOpen(false);
    });
  };
  const transferHost = (memberId: string) => {
    void runDirectMutation('transfer_host', () => transferHostAction(memberId));
  };
  const dissolve = () => {
    void runDirectMutation('dissolve', dissolveRoom);
  };
  const leave = () => {
    void runDirectMutation('leave', leaveRoomMutation);
  };
  const resolveCheckAction = (action: Extract<AllowedRoomAction, 'invite' | 'update_config' | 'update_ai_config'>) => {
    if (action === 'invite') void onCopyInvite();
    else if (action === 'update_ai_config') openAIConfigEditor();
    else setConfigEditorOpen(true);
  };

  const runSeatMutation = (operation: () => Promise<boolean>) => {
    setPageError(null);
    void operation();
  };
  const approveSeatRequest = async (request: RoomSeatRequestView) => {
    setPageError(null);
    setSeatRequestOpen(false);
    if (await respondSeatRequest(request.id, true)) setApprovedSeatRequest(request);
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

        <div className="waiting-room__board">
          <PlayerSeatGrid
            room={room}
            onClaimSeat={(seatIndex) => runSeatMutation(() => claimSeat(seatIndex))}
            onAddAI={(seatIndex) => runSeatMutation(() => addAISeat(seatIndex))}
            onBecomeSpectator={() => runSeatMutation(becomeSpectator)}
            onRequestSeat={() => runSeatMutation(requestSeat)}
            onKickPlayer={(memberId) => runSeatMutation(() => kickPlayer(memberId))}
          />
          <aside className="waiting-room__side" aria-label="等待房辅助信息">
            <RoomActions
              room={room}
              currentMember={currentMember}
              pendingAction={pendingAction}
              onSetReady={ready}
              onBeginReadyCheck={() => runSeatMutation(beginReadyCheck)}
              onCancelReadyCheck={cancel}
              onStartGame={start}
              onInvite={() => void onCopyInvite()}
              onUpdateConfig={() => setConfigEditorOpen(true)}
              onTransferHost={transferHost}
              onDissolve={dissolve}
              onLeave={leave}
            />
            <StartCheckPanel
              items={room.startCheck.items}
              members={room.members}
              allowedActions={room.viewer.allowedRoomActions}
              onAction={resolveCheckAction}
              onLocate={scrollToCheckTarget}
            />
          </aside>
        </div>

        <RoomConfigSummary
          room={room}
          onUpdateConfig={() => setConfigEditorOpen(true)}
          aiSummary={aiSummary}
        />

        {isHost && room.seatRequests?.some((request) => request.status === 'pending') ? (
          <Card className="waiting-room__seat-requests" aria-labelledby="seat-requests-title">
            <div className="waiting-room__section-heading">
              <div><span className="waiting-room__eyebrow">位置申请</span><h2 id="seat-requests-title">有玩家申请加入玩家席</h2></div>
              <Button variant="secondary" onClick={() => setSeatRequestOpen(true)}>查看申请</Button>
            </div>
          </Card>
        ) : null}

        <Modal
          open={seatRequestOpen}
          title="玩家位置申请"
          context="确认后，玩家可以继续点击空席或 AI 席加入玩家席；玩家席满时请先从席位菜单移出玩家。"
          onClose={() => setSeatRequestOpen(false)}
        >
          <div className="waiting-room__seat-request-list">
            {(room.seatRequests ?? []).filter((request) => request.status === 'pending').map((request) => (
              <div key={request.id} className="waiting-room__seat-request">
                <div><strong>{request.requesterName}</strong><span>正在申请玩家位置</span></div>
                <div className="waiting-room__action-list">
                  <Button variant="secondary" onClick={() => { setSeatRequestOpen(false); runSeatMutation(() => respondSeatRequest(request.id, false)); }}>拒绝</Button>
                  <Button onClick={() => void approveSeatRequest(request)}>同意申请并选择移出玩家</Button>
                </div>
              </div>
            ))}
            {(room.seatRequests ?? []).every((request) => request.status !== 'pending') ? <p className="waiting-room__empty-copy">暂无待处理申请。</p> : null}
          </div>
        </Modal>

        <Modal
          open={approvedSeatRequest !== null}
          title="腾出玩家位置"
          context={approvedSeatRequest ? `${approvedSeatRequest.requesterName} 的位置申请已同意，请选择一名真人玩家移出玩家席。` : undefined}
          onClose={() => setApprovedSeatRequest(null)}
        >
          <div className="waiting-room__seat-request-list">
            {room.members
              .filter((member) => member.kind === 'player' && !member.isAI && !member.isHost)
              .map((member) => (
                <Button
                  key={member.id}
                  variant="secondary"
                  onClick={() => {
                    setApprovedSeatRequest(null);
                    runSeatMutation(() => kickPlayer(member.id));
                  }}
                >
                  <X size={17} aria-hidden="true" />移出 {member.name}
                </Button>
              ))}
            {!room.members.some((member) => member.kind === 'player' && !member.isAI && !member.isHost) ? (
              <p className="waiting-room__empty-copy">当前没有可移出的真人玩家；申请人可直接使用空位或 AI 位置。</p>
            ) : null}
          </div>
        </Modal>

        <details className="waiting-room__secondary-details">
          <summary>
            <span>观战席与房间动态</span>
            <span className="waiting-room__secondary-hint">不占用玩家席 · 可展开查看</span>
          </summary>
          <SpectatorList room={room} />
        </details>

        <RoomConfigEditor
          room={room}
          open={configEditorOpen && isHost && isActionAllowed(room, 'update_config')}
          pending={pendingRoomCommand === 'room.update_config'}
          onClose={() => setConfigEditorOpen(false)}
          onSubmit={updateConfig}
          onOpenAIConfig={() => {
            setConfigEditorOpen(false);
            openAIConfigEditor();
          }}
        />

        <RoomAIConfigEditor
          room={room}
          open={aiEditorOpen && isHost && isActionAllowed(room, 'update_ai_config')}
          pending={aiConfigStatus === 'updating'}
          summary={aiSummary}
          status={aiConfigStatus}
          error={aiConfigError}
          onClose={() => setAIEditorOpen(false)}
          onSubmit={updateAI}
        />

        <Card className="waiting-room__footer-note">
          <span>房间状态会自动同步</span>
          <span>· 刷新或重连后会恢复最新房间信息。</span>
        </Card>
      </div>
    </AppShell>
  );
}
