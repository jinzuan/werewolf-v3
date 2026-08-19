import { Minus, Plus, Save, Settings2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { RoomConfigView, RoomViewV31 } from '../../../../shared/roomContract';
import type { Role } from '../../../../shared/types';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Input } from '../../../ui/Input';
import { isActionAllowed } from '../selectors';

const ROLE_ORDER: readonly Role[] = [
  'wolf',
  'seer',
  'witch',
  'hunter',
  'guardian',
  'villager',
];

const ROLE_LABELS: Record<Role, string> = {
  wolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  guardian: '守卫',
  villager: '村民',
};

const totalRoles = (roles: RoomConfigView['roleSetup']): number =>
  ROLE_ORDER.reduce((total, role) => total + (roles[role] ?? 0), 0);

interface WaitingRoomQuickSettingsProps {
  room: RoomViewV31;
  pending: boolean;
  onSubmit: (config: RoomConfigView) => void;
}

export function WaitingRoomQuickSettings({
  room,
  pending,
  onSubmit,
}: WaitingRoomQuickSettingsProps) {
  const canEdit = isActionAllowed(room, 'update_config') && room.status !== 'starting';
  const [draft, setDraft] = useState<RoomConfigView>(room.config);

  useEffect(() => {
    setDraft(room.config);
  }, [room.config]);

  const roleTotal = useMemo(() => totalRoles(draft.roleSetup), [draft.roleSetup]);
  const setRole = (role: Role, value: number) => {
    setDraft((current) => ({
      ...current,
      rolePresetId: undefined,
      roleSetup: {
        ...current.roleSetup,
        [role]: Math.max(0, value),
      },
    }));
  };
  const setMaxPlayers = (value: number) => {
    const nextMax = Math.max(1, value);
    const difference = nextMax - totalRoles(draft.roleSetup);
    setDraft((current) => ({
      ...current,
      maxPlayers: nextMax,
      rolePresetId: undefined,
      roleSetup: {
        ...current.roleSetup,
        // Keep the common case valid while still allowing the host to tune
        // the final role count below before saving.
        villager: Math.max(0, (current.roleSetup.villager ?? 0) + difference),
      },
    }));
  };
  const setAIFill = (enabled: boolean) => {
    setDraft((current) => {
      if (current.mode === 'quick_computer') return current;
      return enabled
        ? {
            ...current,
            mode: 'mixed',
            aiFillPolicy: 'fill_to_max',
            computerSeats: 0,
            minHumanPlayers: Math.min(Math.max(1, current.minHumanPlayers), Math.max(1, current.maxPlayers)),
          }
        : {
            ...current,
            mode: 'human',
            aiFillPolicy: 'none',
            computerSeats: 0,
            minHumanPlayers: current.maxPlayers,
          };
    });
  };

  return (
    <Card className="waiting-room__quick-settings" aria-labelledby="waiting-room-quick-settings-title">
      <div className="waiting-room__section-heading">
        <div className="waiting-room__section-icon" aria-hidden="true"><Settings2 size={20} /></div>
        <div>
          <span className="waiting-room__eyebrow">开局前可调整</span>
          <h2 id="waiting-room-quick-settings-title">等待房快捷设置</h2>
        </div>
        <span className="waiting-room__quick-settings-status">{canEdit ? '房主可编辑' : '仅查看'}</span>
      </div>

      <div className="waiting-room__quick-settings-grid">
        <label className="waiting-room__editor-field">
          <span>对局人数</span>
          <div className="waiting-room__quick-number">
            <Button variant="icon" aria-label="减少对局人数" disabled={!canEdit || draft.maxPlayers <= 1} onClick={() => setMaxPlayers(draft.maxPlayers - 1)}><Minus size={15} /></Button>
            <Input type="number" min={1} max={24} value={draft.maxPlayers} disabled={!canEdit} onChange={(event) => setMaxPlayers(Number(event.target.value) || 1)} />
            <Button variant="icon" aria-label="增加对局人数" disabled={!canEdit || draft.maxPlayers >= 24} onClick={() => setMaxPlayers(draft.maxPlayers + 1)}><Plus size={15} /></Button>
          </div>
        </label>
        <div className="waiting-room__quick-role-total">
          <span>职位数</span>
          <strong className={roleTotal === draft.maxPlayers ? 'is-valid' : 'is-invalid'}>{roleTotal} / {draft.maxPlayers}</strong>
        </div>
        <label className="waiting-room__quick-ai-toggle">
          <input
            type="checkbox"
            checked={draft.mode === 'quick_computer' || (draft.mode !== 'human' && draft.aiFillPolicy !== 'none')}
            disabled={!canEdit || draft.mode === 'quick_computer'}
            onChange={(event) => setAIFill(event.target.checked)}
          />
          <span><strong>AI 补位</strong><small>真人不足时补齐空席</small></span>
        </label>
      </div>

      <div className="waiting-room__quick-role-grid" aria-label="职位数量快捷设置">
        {ROLE_ORDER.map((role) => (
          <label key={role} className="waiting-room__quick-role">
            <span>{ROLE_LABELS[role]}</span>
            <Input type="number" min={0} max={draft.maxPlayers} value={draft.roleSetup[role] ?? 0} disabled={!canEdit} onChange={(event) => setRole(role, Number(event.target.value) || 0)} />
          </label>
        ))}
      </div>

      {canEdit ? (
        <div className="waiting-room__quick-settings-actions">
          <span>角色总数必须等于对局人数，保存后会重新检查准备状态。</span>
          <Button variant="secondary" disabled={pending || roleTotal !== draft.maxPlayers} onClick={() => onSubmit(draft)}><Save size={16} />{pending ? '正在保存…' : '保存快捷设置'}</Button>
        </div>
      ) : null}
    </Card>
  );
}
