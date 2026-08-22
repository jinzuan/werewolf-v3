import { useEffect, useState } from 'react';
import type { RoomConfigView, RoomViewV31 } from '../../../../shared/roomContract';
import type { Role } from '../../../../shared/types';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Input';
import { Modal } from '../../../ui/Modal';

const ROLE_ORDER: Role[] = [
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

const FILL_LABELS: Record<RoomConfigView['aiFillPolicy'], string> = {
  none: '不补位',
  fixed: '按预设电脑席',
  fill_to_max: '开局时补满空席',
};

interface RoomConfigEditorProps {
  room: RoomViewV31;
  open: boolean;
  pending: boolean;
  onClose: () => void;
  onSubmit: (config: RoomConfigView) => void;
  onOpenAIConfig?: () => void;
}

export function RoomConfigEditor({
  room,
  open,
  pending,
  onClose,
  onSubmit,
  onOpenAIConfig,
}: RoomConfigEditorProps) {
  const [draft, setDraft] = useState<RoomConfigView>(room.config);

  useEffect(() => {
    if (open) setDraft(room.config);
  }, [open, room.config]);

  const setNumber = (key: 'maxPlayers' | 'minHumanPlayers' | 'computerSeats', value: string) => {
    const number = Number.parseInt(value, 10);
    setDraft((current) => ({
      ...current,
      [key]: Number.isFinite(number) ? Math.max(0, number) : 0,
    }));
  };

  const setRoleCount = (role: Role, value: string) => {
    const number = Number.parseInt(value, 10);
    setDraft((current) => ({
      ...current,
      roleSetup: {
        ...current.roleSetup,
        [role]: Number.isFinite(number) ? Math.max(0, number) : 0,
      },
    }));
  };

  return (
    <Modal
      open={open}
      title="房间设置"
      context="基础设置、角色、AI 补位与规则集中在这里；保存后会刷新开局检查。"
      onClose={onClose}
      size="wide"
      footer={(
        <>
          <Button variant="quiet" disabled={pending} onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() => onSubmit(draft)}
          >
            {pending ? '正在保存…' : '保存设置'}
          </Button>
        </>
      )}
    >
      <div className="waiting-room__editor">
        <div className="waiting-room__editor-grid">
          <label className="waiting-room__editor-field">
            <span>对局人数</span>
            <Input
              type="number"
              min={1}
              max={24}
              value={draft.maxPlayers}
              onChange={(event) => setNumber('maxPlayers', event.target.value)}
            />
          </label>
          <label className="waiting-room__editor-field">
            <span>最低真人人数</span>
            <Input
              type="number"
              min={0}
              max={draft.maxPlayers}
              value={draft.minHumanPlayers}
              onChange={(event) => setNumber('minHumanPlayers', event.target.value)}
            />
          </label>
          <label className="waiting-room__editor-field">
            <span>预设电脑席</span>
            <Input
              type="number"
              min={0}
              max={draft.maxPlayers}
              value={draft.computerSeats}
              onChange={(event) => setNumber('computerSeats', event.target.value)}
            />
          </label>
          <label className="waiting-room__editor-field">
            <span>补位策略</span>
            <select
              value={draft.aiFillPolicy}
              onChange={(event) => setDraft((current) => ({
                ...current,
                aiFillPolicy: event.target.value as RoomConfigView['aiFillPolicy'],
              }))}
            >
              {Object.entries(FILL_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="waiting-room__editor-roles">
          <legend>角色构成（共 {draft.maxPlayers} 个席位）</legend>
          <div className="waiting-room__editor-role-grid">
            {ROLE_ORDER.map((role) => (
              <label key={role} className="waiting-room__editor-field">
                <span>{ROLE_LABELS[role]}</span>
                <Input
                  type="number"
                  min={0}
                  max={draft.maxPlayers}
                  value={draft.roleSetup[role] ?? 0}
                  onChange={(event) => setRoleCount(role, event.target.value)}
                />
              </label>
            ))}
          </div>
        </fieldset>

        {draft.mode !== 'human' && onOpenAIConfig ? (
          <div className="waiting-room__editor-ai-link">
            <div><strong>电脑玩家</strong><span>模型、接口、凭据和行动风格使用同一房间设置入口。</span></div>
            <Button variant="secondary" onClick={onOpenAIConfig}>AI 参数与服务</Button>
          </div>
        ) : null}

        <details className="waiting-room__editor-advanced">
          <summary>高级设置：观战与局后复盘</summary>
          <div className="waiting-room__editor-checks">
            <label className="waiting-room__editor-check">
              <input
                type="checkbox"
                checked={draft.allowPublicSpectators}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  allowPublicSpectators: event.target.checked,
                }))}
              />
              <span>允许观战及玩家协助邀请</span>
            </label>
            <label className="waiting-room__editor-check">
              <input
                type="checkbox"
                checked={draft.reviewEnabled}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  reviewEnabled: event.target.checked,
                }))}
              />
              <span>对局结束后开启复盘</span>
            </label>
            {draft.reviewEnabled ? (
              <label className="waiting-room__editor-check">
                <input
                  type="checkbox"
                  checked={draft.reviewMode === 'ai'}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    reviewMode: event.target.checked ? 'ai' : 'rules',
                  }))}
                />
                <span>使用 AI 生成复盘总结（无凭据自动降级）</span>
              </label>
            ) : null}
          </div>
        </details>
      </div>
    </Modal>
  );
}
