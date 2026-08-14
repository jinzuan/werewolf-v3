import { Circle, Eye } from 'lucide-react';
import type { RoomViewV31 } from '../../../../shared/roomContract';
import { Badge } from '../../../ui/Badge';
import { Card } from '../../../ui/Card';
import { Status } from '../../../ui/Status';
import { selectSpectators, spectatorPresenceLabel } from '../selectors';

interface SpectatorListProps {
  room: RoomViewV31;
}

export function SpectatorList({ room }: SpectatorListProps) {
  const spectators = selectSpectators(room);

  return (
    <Card className="waiting-room__spectators" aria-labelledby="spectator-title">
      <div className="waiting-room__section-heading">
        <div className="waiting-room__section-icon" aria-hidden="true">
          <Eye size={20} />
        </div>
        <div>
          <span className="waiting-room__eyebrow">不占用玩家席</span>
          <h2 id="spectator-title">观战席</h2>
        </div>
        <Badge tone="info">{spectators.length} 人</Badge>
      </div>

      {spectators.length ? (
        <ul className="waiting-room__spectator-list">
          {spectators.map((member) => (
            <li key={member.id} className="waiting-room__spectator">
              <span className="waiting-room__spectator-avatar" aria-hidden="true">
                <Circle size={17} />
              </span>
              <span className="waiting-room__spectator-name">
                <strong>{member.name}</strong>
                <span>观战者</span>
              </span>
              <Status
                tone={member.connected ? 'success' : 'danger'}
                label={spectatorPresenceLabel(member)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="waiting-room__empty-copy">暂时没有观战者。</p>
      )}
    </Card>
  );
}
