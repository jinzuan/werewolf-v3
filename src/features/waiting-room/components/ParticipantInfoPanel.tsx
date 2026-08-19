import { Bot, CircleUserRound, Users } from 'lucide-react';
import type { RoomViewV31 } from '../../../../shared/roomContract';
import { Badge } from '../../../ui/Badge';
import { Card } from '../../../ui/Card';
import { memberReadyLabel } from '../selectors';

interface ParticipantInfoPanelProps {
  room: RoomViewV31;
}

export function ParticipantInfoPanel({ room }: ParticipantInfoPanelProps) {
  const participants = room.members
    .filter((member) => member.kind === 'player')
    .sort((left, right) => (left.seatIndex ?? Number.MAX_SAFE_INTEGER) - (right.seatIndex ?? Number.MAX_SAFE_INTEGER));

  return (
    <Card className="waiting-room__participants" aria-labelledby="participant-info-title">
      <div className="waiting-room__section-heading">
        <div className="waiting-room__section-icon" aria-hidden="true"><Users size={20} /></div>
        <div>
          <span className="waiting-room__eyebrow">独立成员信息</span>
          <h2 id="participant-info-title">参与玩家</h2>
        </div>
        <span className="waiting-room__check-count">{participants.length} 人</span>
      </div>

      {participants.length ? (
        <ul className="waiting-room__participant-list">
          {participants.map((member) => (
            <li key={member.id} className="waiting-room__participant">
              <span className="waiting-room__participant-icon" aria-hidden="true">
                {member.isAI ? <Bot size={17} /> : <CircleUserRound size={17} />}
              </span>
              <span className="waiting-room__participant-main">
                <strong>{member.name}</strong>
                <span>{member.seatIndex === null ? '未入座' : `${member.seatIndex + 1}号席位`} · {member.isAI ? 'AI 玩家' : '真人玩家'}</span>
              </span>
              <span className="waiting-room__participant-badges">
                {member.isHost ? <Badge tone="gold">房主</Badge> : null}
                <Badge tone={member.connected ? 'success' : 'warning'}>{member.isAI ? 'AI 在线' : memberReadyLabel(member)}</Badge>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="waiting-room__empty-copy">还没有参与玩家。</p>
      )}
    </Card>
  );
}
