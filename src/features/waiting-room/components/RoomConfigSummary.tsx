import { Settings2 } from 'lucide-react';
import type { RoomConfigView, RoomViewV31 } from '../../../../shared/roomContract';
import type { RoomAIConfigSummary } from '../../../../shared/aiRoomConfigContract';
import type { Role } from '../../../../shared/types';
import { roomModeLabel } from '../../../v3/presentation';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { isActionAllowed } from '../selectors';
import { viewerPlayerId } from '../../../v3/session';

const ROLE_LABELS: Record<Role, string> = {
  wolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  guardian: '守卫',
  villager: '村民',
};

const FILL_LABELS: Record<RoomConfigView['aiFillPolicy'], string> = {
  none: '不补位',
  fixed: '按预设电脑席',
  fill_to_max: '开局时补满空席',
};

const visibilityLabel = (visibility: RoomConfigView['visibility']): string =>
  visibility === 'listed' ? '大厅可见' : '仅凭邀请';

interface RoomConfigSummaryProps {
  room: RoomViewV31;
  onUpdateConfig: () => void;
  aiSummary: RoomAIConfigSummary | null;
  onUpdateAIConfig: () => void;
}

export function RoomConfigSummary({ room, onUpdateConfig, aiSummary, onUpdateAIConfig }: RoomConfigSummaryProps) {
  const { config } = room;
  const roleEntries = (Object.keys(ROLE_LABELS) as Role[])
    .map((role) => ({ role, count: config.roleSetup[role] ?? 0 }))
    .filter(({ count }) => count > 0);
  const viewerId = viewerPlayerId(room.viewer);
  const isHost = viewerId !== null && room.members.some(
    (member) => member.kind === 'player' && member.id === viewerId && member.isHost,
  );
  const aiCheck = room.startCheck.items.find((item) => item.key === 'ai_provider_config');
  const aiReady = aiCheck?.passed ?? room.computerPlayerStatus !== 'invalid';

  return (
    <Card className="waiting-room__config" aria-labelledby="room-config-title">
      <div className="waiting-room__section-heading">
        <div className="waiting-room__section-icon" aria-hidden="true">
          <Settings2 size={20} />
        </div>
        <div>
          <span className="waiting-room__eyebrow">房间信息</span>
          <h2 id="room-config-title">房间设置</h2>
        </div>
        <Badge tone={room.configLocked ? 'warning' : 'success'}>
          {room.configLocked ? '已锁定' : '可修改'}
        </Badge>
      </div>

      <dl className="waiting-room__config-grid">
        <div><dt>房间模式</dt><dd>{roomModeLabel(config.mode)}</dd></div>
        <div><dt>可见性</dt><dd>{visibilityLabel(config.visibility)}</dd></div>
        <div><dt>真人门槛</dt><dd>至少 {config.minHumanPlayers} 名</dd></div>
        <div><dt>补位策略</dt><dd>{FILL_LABELS[config.aiFillPolicy]}</dd></div>
        <div><dt>准备规则</dt><dd>所有在线真人准备</dd></div>
        <div><dt>规则集</dt><dd>{config.rulesetVersion}</dd></div>
        <div><dt>局后复盘</dt><dd>{config.reviewEnabled ? (config.reviewMode === 'ai' ? 'AI 复盘' : '上帝视角') : '关闭'}</dd></div>
      </dl>

      <div className="waiting-room__role-summary">
        <span className="waiting-room__eyebrow">角色构成 · {config.maxPlayers} 个席位</span>
        <div className="waiting-room__role-list">
          {roleEntries.map(({ role, count }) => (
            <span key={role}>{ROLE_LABELS[role]} × {count}</span>
          ))}
        </div>
      </div>

      {config.mode !== 'human' ? (
        <div className="waiting-room__ai-summary" data-ai-config-status={aiReady ? 'ready' : 'invalid'}>
          <div>
            <span className="waiting-room__eyebrow">电脑玩家设置</span>
            <strong>{aiSummary ? `${aiSummary.provider} · ${aiSummary.model}` : aiReady ? '使用安全演示策略' : '需要重新配置'}</strong>
            <span className="waiting-room__ai-summary-status">
              {aiReady ? '电脑玩家配置就绪' : '电脑玩家配置未就绪'}
              {aiSummary ? ` · ${aiSummary.endpointOrigin}` : ''}
            </span>
          </div>
          {isHost && isActionAllowed(room, 'update_ai_config') ? (
            <Button
              variant="secondary"
              disabled={room.configLocked || room.status === 'starting'}
              onClick={onUpdateAIConfig}
            >
              <Settings2 size={16} aria-hidden="true" />
              修改电脑玩家设置
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="waiting-room__empty-copy">当前为纯真人房，没有电脑玩家设置。</p>
      )}

      {isHost && isActionAllowed(room, 'update_config') ? (
        <Button
          variant="secondary"
          disabled={room.configLocked || room.status === 'starting'}
          onClick={onUpdateConfig}
        >
          <Settings2 size={16} aria-hidden="true" />
          修改房间设置
        </Button>
      ) : null}
    </Card>
  );
}
