import { Bot, Info, Maximize2, Minimize2, UserRound, UserRoundPlus, Users, X } from 'lucide-react';
import { useState } from 'react';
import type { RoomViewV31 } from '../../../../shared/roomContract';
import { Button } from '../../../ui/Button';
import { Modal } from '../../../ui/Modal';
import { Seat } from '../../../ui/Seat';
import { avatarAssetMap } from '../../../ui/assetRegistry';
import {
  isActionAllowed,
  memberReadyLabel,
  selectPlayerSeats,
  selectUnassignedPlayers,
} from '../selectors';
import { viewerPlayerId } from '../../../v3/session';

interface PlayerSeatGridProps {
  room: RoomViewV31;
  onSeatListFocus?: () => void;
  onClaimSeat?: (seatIndex: number) => void;
  onAddAI?: (seatIndex: number) => void;
  onBecomeSpectator?: () => void;
  onRequestSeat?: () => void;
  onKickPlayer?: (memberId: string) => void;
}

export function PlayerSeatGrid({
  room,
  onSeatListFocus,
  onClaimSeat,
  onAddAI,
  onBecomeSpectator,
  onRequestSeat,
  onKickPlayer,
}: PlayerSeatGridProps) {
  const seats = selectPlayerSeats(room);
  const unassigned = selectUnassignedPlayers(room);
  const occupied = seats.filter((seat) => seat.member).length;
  const [selectedSeat, setSelectedSeat] = useState<number | null>(null);
  const [compact, setCompact] = useState(false);
  const selectedMember = selectedSeat === null
    ? undefined
    : seats.find((seat) => seat.seatIndex === selectedSeat)?.member ?? undefined;
  const viewerId = viewerPlayerId(room.viewer);
  const currentMember = room.members.find((member) => member.id === viewerId);
  const isHost = currentMember?.isHost === true;
  const closeMenu = () => setSelectedSeat(null);
  const run = (action: (() => void) | undefined) => {
    closeMenu();
    action?.();
  };
  const canClaim = room.viewer.kind === 'spectator' && isActionAllowed(room, 'claim_seat');
  const canApply = isActionAllowed(room, 'request_seat');
  const canBecomeSpectator = room.viewer.kind === 'player' && isActionAllowed(room, 'become_spectator');
  const canKick = isHost && selectedMember?.kind === 'player' && !selectedMember.isAI && !selectedMember.isHost && isActionAllowed(room, 'kick_player');
  const canAddAI = isHost && isActionAllowed(room, 'add_ai') && room.config.mode !== 'human';
  const autoFillEnabled = room.config.aiFillPolicy !== 'none';
  const openSeat = (seatIndex: number, hasMember: boolean) => {
    // A spectator clicking an empty seat is the quick-join affordance. Hosts
    // still get the menu so an accidental click cannot consume a seat.
    if (!hasMember && !isHost && canClaim) {
      run(() => onClaimSeat?.(seatIndex));
      return;
    }
    setSelectedSeat(seatIndex);
  };

  return (
    <section className="waiting-room__players" aria-labelledby="player-seats-title">
      <div className="waiting-room__section-heading">
        <div className="waiting-room__section-icon" aria-hidden="true">
          <UserRound size={20} />
        </div>
        <div>
          <span className="waiting-room__eyebrow">真实房间成员</span>
          <h2 id="player-seats-title">玩家席</h2>
        </div>
        <span className="waiting-room__check-count">{occupied} / {seats.length}</span>
        <Button
          variant="quiet"
          className="waiting-room__seat-density-toggle"
          onClick={() => setCompact((value) => !value)}
          aria-pressed={compact}
        >
          {compact ? <Maximize2 size={15} /> : <Minimize2 size={15} />}
          {compact ? '展开显示' : '压缩显示'}
        </Button>
      </div>

      <div className="waiting-room__seat-scroll" onFocus={onSeatListFocus}>
        <div className={`waiting-room__seat-grid${compact ? ' waiting-room__seat-grid--compact' : ''}`}>
        {seats.map(({ seatIndex, member }) => {
          if (!member) {
            return (
              <Seat
                key={`empty-${seatIndex}`}
                seatNumber={seatIndex + 1}
                kind="empty"
                presence="idle"
                selected={selectedSeat === seatIndex}
                disabled={false}
                onClick={() => openSeat(seatIndex, false)}
              />
            );
          }

          const kind = member.isAI ? 'computer' : 'player';
          const presence = member.connected
            ? member.isAI || member.ready ? 'ready' : 'online'
            : 'offline';
          return (
              <Seat
                key={member.id}
                seatNumber={seatIndex + 1}
              name={member.name}
              kind={kind}
              presence={presence}
                host={member.isHost}
                colorTone={seatIndex}
              statusLabel={memberReadyLabel(member)}
              avatarAsset={member.isAI ? avatarAssetMap.computer : avatarAssetMap.player}
              selected={selectedSeat === seatIndex}
              disabled={false}
              onClick={() => openSeat(seatIndex, true)}
            />
          );
        })}
        </div>
      </div>

      <p className="waiting-room__seat-note">
        点击席位查看快捷操作；观战席不占用玩家席，玩家席满时不会强制挤入。
      </p>

      {unassigned.length ? (
        <div className="waiting-room__unassigned" aria-label="待分配席位">
          <span className="waiting-room__eyebrow">待分配席位</span>
          {unassigned.map((member) => (
            <span key={member.id} className="waiting-room__unassigned-member">
              {member.name} · 正在安排席位
            </span>
          ))}
        </div>
      ) : null}

      <Modal
        open={selectedSeat !== null}
        title={selectedMember ? `${selectedSeat! + 1}号席位 · ${selectedMember.name}` : `${(selectedSeat ?? 0) + 1}号席位`}
        context={selectedMember?.isAI ? '这是电脑玩家席位。' : selectedMember ? '这是玩家席位。' : '这是空的玩家席位。'}
        onClose={closeMenu}
      >
        <div className="waiting-room__seat-menu">
          {selectedMember ? (
            <div className="waiting-room__seat-profile">
              {selectedMember.isAI ? <Bot size={24} aria-hidden="true" /> : <Users size={24} aria-hidden="true" />}
              <div><strong>{selectedMember.name}</strong><span>{selectedMember.isAI ? 'AI 信息 · 系统自动行动' : `个人信息 · ${memberReadyLabel(selectedMember)}`}</span></div>
            </div>
          ) : (
            <div className="waiting-room__seat-profile"><UserRoundPlus size={24} aria-hidden="true" /><div><strong>空位</strong><span>等待玩家入座</span></div></div>
          )}

          {selectedMember ? (
            <div className="waiting-room__seat-info" role="status">
              <Info size={16} aria-hidden="true" />
              <span>{selectedMember.isAI ? 'AI 玩家：已加入本局席位，开局后由系统行动。' : `玩家：${selectedMember.connected ? '在线' : '离线'}，${selectedMember.isHost ? '房主' : '普通玩家'}。`}</span>
            </div>
          ) : null}

          {selectedMember?.isAI && canClaim ? (
            autoFillEnabled ? (
              <Button size="action" onClick={() => run(() => onClaimSeat?.(selectedSeat!))}><UserRoundPlus size={17} />进入玩家席<span className="waiting-room__seat-action-hint">自动顶替这名电脑玩家</span></Button>
            ) : (
              <div className="v3-alert v3-alert--warning" role="alert">玩家已满。当前未开启 AI 自动补位。</div>
            )
          ) : null}
          {!selectedMember && canClaim ? <Button size="action" onClick={() => run(() => onClaimSeat?.(selectedSeat!))}><UserRoundPlus size={17} />进入玩家席</Button> : null}
          {selectedMember && !selectedMember.isAI && selectedMember.id !== viewerId && canApply ? <Button variant="secondary" onClick={() => run(onRequestSeat)}><UserRoundPlus size={17} />申请玩家位置</Button> : null}
          {selectedMember?.id === viewerId && canBecomeSpectator ? <Button variant="secondary" onClick={() => run(onBecomeSpectator)}><Users size={17} />加入观战席</Button> : null}
          {canKick ? <Button variant="quiet" onClick={() => run(() => onKickPlayer?.(selectedMember!.id))}><X size={17} />房主移出玩家席</Button> : null}
          {!selectedMember && canAddAI ? <Button variant="secondary" onClick={() => run(() => onAddAI?.(selectedSeat!))}><Bot size={17} />添加 AI 玩家</Button> : null}
          <p className="waiting-room__seat-menu-note">观战席不占用玩家席位。</p>
        </div>
      </Modal>
    </section>
  );
}
