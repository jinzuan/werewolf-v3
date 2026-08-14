import { Bot, UserRound } from 'lucide-react';
import type { RoomViewV31 } from '../../../../shared/roomContract';
import { Seat } from '../../../ui/Seat';
import {
  memberReadyLabel,
  selectPlayerSeats,
  selectUnassignedPlayers,
} from '../selectors';

interface PlayerSeatGridProps {
  room: RoomViewV31;
  onSeatListFocus?: () => void;
}

export function PlayerSeatGrid({ room, onSeatListFocus }: PlayerSeatGridProps) {
  const seats = selectPlayerSeats(room);
  const unassigned = selectUnassignedPlayers(room);
  const occupied = seats.filter((seat) => seat.member).length;

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
      </div>

      <div className="waiting-room__seat-grid" onFocus={onSeatListFocus}>
        {seats.map(({ seatIndex, member }) => {
          if (!member) {
            return (
              <Seat
                key={`empty-${seatIndex}`}
                seatNumber={seatIndex + 1}
                kind="empty"
                presence="idle"
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
              statusLabel={memberReadyLabel(member)}
              avatar={member.isAI ? <Bot size={21} aria-hidden="true" /> : <UserRound size={21} aria-hidden="true" />}
              disabled
            />
          );
        })}
      </div>

      {unassigned.length ? (
        <div className="waiting-room__unassigned" aria-label="待分配席位">
          <span className="waiting-room__eyebrow">待分配席位</span>
          {unassigned.map((member) => (
            <span key={member.id} className="waiting-room__unassigned-member">
              {member.name} · 服务端正在安排席位
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
