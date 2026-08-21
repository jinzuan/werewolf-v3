import { Circle, Eye } from 'lucide-react';
import type { RoomViewV31 } from '../../../../shared/roomContract';
import { Badge } from '../../../ui/Badge';
import { Status } from '../../../ui/Status';
import { selectSpectators, spectatorPresenceLabel } from '../selectors';

interface SpectatorListProps {
  room: RoomViewV31;
  embedded?: boolean;
}

export function SpectatorList({ room, embedded = false }: SpectatorListProps) {
  const spectators = selectSpectators(room);
  const content = (
    <>
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
    </>
  );

  return embedded ? (
    <details className="waiting-room__spectators waiting-room__spectators--embedded">
      <summary>
        <span><Eye size={17} aria-hidden="true" />观战席</span>
        <Badge tone="info">{spectators.length} 人</Badge>
      </summary>
      {content}
    </details>
  ) : (
    <section className="v3-card waiting-room__spectators" aria-labelledby="spectator-title">
      {content}
    </section>
  );
}
