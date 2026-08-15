import { AlertTriangle, Check, CircleHelp, UserRound } from 'lucide-react';
import type {
  AllowedRoomAction,
  RoomMemberViewV31,
  StartCheckItem,
} from '../../../../shared/roomContract';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { startCheckCopy } from '../selectors';

interface StartCheckPanelProps {
  items: StartCheckItem[];
  members: RoomMemberViewV31[];
  allowedActions: readonly AllowedRoomAction[];
  onAction: (action: Extract<AllowedRoomAction, 'invite' | 'update_config'>) => void;
  onLocate: (item: StartCheckItem) => void;
}

export function StartCheckPanel({
  items,
  members,
  allowedActions,
  onAction,
  onLocate,
}: StartCheckPanelProps) {
  const passed = items.filter((item) => item.passed).length;
  const memberNames = new Map(members.map((member) => [member.id, member.name]));

  return (
    <Card className="waiting-room__checks" aria-labelledby="start-check-title">
      <div className="waiting-room__section-heading">
        <div className="waiting-room__section-icon" aria-hidden="true">
          <CircleHelp size={20} />
        </div>
        <div>
          <span className="waiting-room__eyebrow">开局检查</span>
          <h2 id="start-check-title">开局检查</h2>
        </div>
        <span className="waiting-room__check-count">{passed} / {items.length} 通过</span>
      </div>

      {items.length ? (
        <ul className="waiting-room__check-list">
          {items.map((item) => {
            const copy = startCheckCopy(item);
            const affectedNames = (item.affectedMemberIds ?? [])
              .map((id) => memberNames.get(id))
              .filter((name): name is string => Boolean(name));
            const canResolve = copy.remedyAction && allowedActions.includes(copy.remedyAction);

            return (
              <li
                className={`waiting-room__check-item ${item.passed ? 'is-passed' : 'is-failed'}`}
                key={item.key}
              >
                <span className="waiting-room__check-icon" aria-hidden="true">
                  {item.passed ? <Check size={17} /> : <AlertTriangle size={17} />}
                </span>
                <div className="waiting-room__check-copy">
                  <strong>{copy.label}</strong>
                  <span>{item.passed ? copy.reason : copy.reason}</span>
                  {affectedNames.length ? (
                    <span className="waiting-room__affected-members">
                      <UserRound size={13} aria-hidden="true" />
                      {affectedNames.join('、')}
                    </span>
                  ) : null}
                  {!item.passed ? (
                    <div className="waiting-room__check-remedy">
                      {canResolve ? (
                        <Button
                          variant="quiet"
                          onClick={() => onAction(copy.remedyAction!)}
                        >
                          {copy.remedy}
                        </Button>
                      ) : (
                        <Button variant="quiet" onClick={() => onLocate(item)}>
                          {copy.remedy}
                        </Button>
                      )}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="waiting-room__check-empty">
          <CircleHelp size={18} aria-hidden="true" />
          <span>正在检查本局开局条件。</span>
        </div>
      )}
    </Card>
  );
}
