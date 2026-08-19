import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  Minus,
  Plus,
  Sparkles,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/shell/AppShell';
import { useV3Store } from '../../stores/v3Store';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Input } from '../../ui/Input';
import { RoleCard } from '../../ui/RoleCard';
import { Seat } from '../../ui/Seat';
import { avatarAssetMap } from '../../ui/assetRegistry';
import { Modal } from '../../ui/Modal';
import { readPlayerNickname, writePlayerNickname } from '../../runtime/playerProfile';
import type { RoomCreationCatalog } from '../../../shared/roomContract';
import {
  clearWizardDraft,
  cloneDraft,
  createInitialDraft,
  issuesForStep,
  messageForIssue,
  normalizeWizardStep,
  optionsFromDraft,
  readWizardDraft,
  ROLE_DESCRIPTIONS,
  ROLE_KEYS,
  ROLE_LABELS,
  roleSetupTotal,
  serverIssuesToWizardIssues,
  stepIndex,
  validateWizardStep,
  wizardPathForStep,
  writeWizardDraft,
  WIZARD_STEPS,
  WIZARD_STEP_PATHS,
  type WizardDraft,
  type WizardIssue,
  type WizardStep,
} from './model';

const css = (...values: string[]): CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ww-space-4)',
  ...Object.fromEntries(values.map((value) => [value, `var(--ww-space-4)`])),
});

const grid: CSSProperties = {
  display: 'grid',
  gap: 'var(--ww-space-6)',
  alignItems: 'start',
};

const row: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 'var(--ww-space-3)',
};

const choiceStyle = (selected: boolean): CSSProperties => ({
  minHeight: 'var(--ww-height-control)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  justifyContent: 'center',
  gap: '3px',
  flex: '1 1 160px',
  padding: 'var(--ww-space-3) var(--ww-space-4)',
  border: `1.5px solid ${selected ? 'var(--ww-action-primary)' : 'var(--ww-border-default)'}`,
  borderRadius: 'var(--ww-radius-control)',
  background: selected ? 'var(--ww-bg-subtle)' : 'var(--ww-bg-raised)',
  color: 'var(--ww-text-default)',
  cursor: 'pointer',
  textAlign: 'left',
});

const storageTarget = (): Storage | null =>
  typeof sessionStorage === 'undefined' ? null : sessionStorage;

const countEnabled = (catalog: RoomCreationCatalog, count: number): boolean =>
  catalog.rolePresets.some((preset) => preset.playerCount === count && preset.enabled);

const presetFor = (catalog: RoomCreationCatalog, count: number) =>
  catalog.rolePresets.find((preset) => preset.playerCount === count && preset.enabled);

const modeDescription: Record<WizardDraft['mode'], string> = {
  human: '邀请朋友入座，一起准备后开局。',
  mixed: '保留 1 名真人，其余空席自动由电脑补上。',
  quick_computer: '不用等人，确认后立即开局并进入监控。',
};

const modeLabel: Record<WizardDraft['mode'], string> = {
  human: '朋友房',
  mixed: '混合房',
  quick_computer: '快速电脑局',
};

const strategyLabel: Record<WizardDraft['aiFillPolicy'], string> = {
  none: '不补位',
  fixed: '按预设电脑席',
  fill_to_max: '开局时补满空席',
};

const issueBlock = (path: string): string => {
  if (path.startsWith('roleSetup')) return 'roleSetup';
  if (path === 'visibility' || path === 'readyPolicy' || path === 'allowPublicSpectators' || path === 'reviewEnabled' || path.startsWith('ruleset')) return 'rules';
  if (path === 'creator.name' || path === 'creator.avatarId') return 'creator';
  return 'players';
};

const codeFallbackStep = (code: string): WizardStep => {
  if (code === 'ROLE_COUNT_MISMATCH' || code === 'INVALID_ROLE_SETUP') return 'roles';
  if (code === 'RULESET_UNAVAILABLE') return 'players';
  return 'roles';
};

function WizardStepper({
  current,
  draft,
  catalog,
  serverIssues,
  onNavigate,
}: {
  current: WizardStep;
  draft: WizardDraft;
  catalog: RoomCreationCatalog;
  serverIssues: WizardIssue[];
  onNavigate: (step: WizardStep) => void;
}) {
  const currentIndex = stepIndex(current);
  return (
    <nav aria-label="创建房间步骤" style={{ marginBottom: 'var(--ww-space-6)' }}>
      <div style={{ ...row, alignItems: 'stretch' }}>
        {WIZARD_STEPS.map((item, index) => {
          const local = item.id === 'roles'
            ? validateWizardStep(draft, 'roles', catalog)
            : issuesForStep(draft, item.id, catalog);
          const errorCount = (item.id === 'roles' ? local : local.filter((candidate) => candidate.step === item.id)).length +
            (item.id === 'roles' ? serverIssues.length : serverIssues.filter((candidate) => candidate.step === item.id).length);
          const canClick = index <= currentIndex || WIZARD_STEPS.slice(0, index).every(
            (prior) => validateWizardStep(draft, prior.id, catalog).length === 0,
          );
          return (
            <span key={item.id} style={{ display: 'contents' }}>
              <button
                type="button"
                className="v3-button v3-button--quiet"
                aria-current={item.id === current ? 'step' : undefined}
                disabled={!canClick}
                onClick={() => onNavigate(item.id)}
                style={{
                  flex: '1 1 140px',
                  justifyContent: 'flex-start',
                  border: item.id === current ? '1.5px solid var(--ww-action-primary)' : '1.5px solid transparent',
                  background: item.id === current ? 'var(--ww-bg-subtle)' : undefined,
                }}
              >
                <span aria-hidden="true">{index + 1}</span>
                <span>{item.label}</span>
                {errorCount > 0 ? <Badge tone="danger">{errorCount}项</Badge> : <Check size={15} aria-label="已完成" />}
              </button>
              {index < WIZARD_STEPS.length - 1 ? <span aria-hidden="true" style={{ alignSelf: 'center', color: 'var(--ww-border-default)' }}>—</span> : null}
            </span>
          );
        })}
      </div>
      <p style={{ margin: 'var(--ww-space-3) 0 0', color: 'var(--ww-text-muted)', fontSize: 'var(--ww-text-caption-size)' }}>
        当前步骤：{WIZARD_STEPS[currentIndex].label}；标出的项目需要处理后才能继续。
      </p>
    </nav>
  );
}

function RoomPreview({ draft }: { draft: WizardDraft }) {
  const expectedComputerSeats = draft.aiFillPolicy === 'fill_to_max'
    ? Math.max(0, draft.maxPlayers - draft.minHumanPlayers)
    : draft.computerSeats;
  return (
    <Card className="v3-room-preview">
      <div className="v3-card-heading">
        <Sparkles size={20} />
        <div>
          <h2>本局预览</h2>
          <p>这里只展示你的配置草稿，创建后会显示最终房间设置。</p>
        </div>
      </div>
      <div className="v3-room-preview__facts">
        <strong>{draft.roomName || '未命名房间'}</strong>
        <span>{modeLabel[draft.mode]} · {draft.maxPlayers || '—'}个席位</span>
        <span>{expectedComputerSeats}个电脑席 · 至少{draft.minHumanPlayers}名真人</span>
        <span>规则版本：{draft.rulesetVersion || '尚未选择'}</span>
        <span>补位：{strategyLabel[draft.aiFillPolicy]}</span>
      </div>
      <div className="v3-room-preview__badges">
        <Badge tone="info">总席位 {draft.maxPlayers || '—'}</Badge>
        <Badge tone="warning">预计电脑 {expectedComputerSeats}</Badge>
        <Badge tone="success">最低真人 {draft.minHumanPlayers}</Badge>
      </div>
    </Card>
  );
}

function SeatPreview({ draft }: { draft: WizardDraft }) {
  const expectedComputerSeats = draft.aiFillPolicy === 'fill_to_max'
    ? Math.max(0, draft.maxPlayers - draft.minHumanPlayers)
    : draft.computerSeats;
  const humanSeats = Math.max(0, draft.maxPlayers - expectedComputerSeats);
  return (
    <div className="v3-seat-preview">
      <div className="v3-seat-preview__heading">
        <strong>席位投影</strong>
        <span style={{ color: 'var(--ww-text-muted)' }}>预计 {humanSeats} 真人席 · {expectedComputerSeats} 电脑席</span>
      </div>
      <div className="v3-seat-preview__grid">
        {Array.from({ length: Math.max(0, draft.maxPlayers) }, (_, index) => {
          const isComputer = index >= humanSeats;
          return (
            <Seat
              key={index}
              seatNumber={index + 1}
              kind={isComputer ? 'computer' : index === 0 && draft.mode !== 'quick_computer' ? 'player' : 'empty'}
              presence={isComputer ? 'waiting' : index === 0 && draft.mode !== 'quick_computer' ? 'online' : 'idle'}
              name={isComputer ? '预计电脑席' : index === 0 && draft.mode !== 'quick_computer' ? draft.creator.name || '创建者' : undefined}
              meta={isComputer ? '创建时自动安排' : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

function FieldError({ issue: error }: { issue?: WizardIssue }) {
  return error ? <span role="alert" style={{ color: 'var(--ww-state-danger)', fontSize: 'var(--ww-text-caption-size)' }}>{error.message}</span> : null;
}

function SeatStepper({
  label,
  value,
  min,
  max,
  issue,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  issue?: WizardIssue;
  onChange: (value: number) => void;
}) {
  const clamp = (next: number): number => Math.max(min, Math.min(max, next));
  const setValue = (next: number): void => onChange(clamp(next));

  return (
    <label className="v3-field" style={{ minWidth: 220, flex: '1 1 240px', margin: 0 }}>
      <span>{label}</span>
      <div style={row} role="group" aria-label={`${label}调节`}>
        <Button
          variant="icon"
          aria-label={`减少${label}`}
          disabled={value <= min}
          onClick={() => setValue(value - 1)}
        >
          <Minus size={16} aria-hidden="true" />
        </Button>
        <Input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={value}
          aria-label={label}
          aria-invalid={Boolean(issue)}
          onChange={(event) => setValue(Number(event.target.value) || min)}
          style={{ width: 82, textAlign: 'center' }}
        />
        <Button
          variant="icon"
          aria-label={`增加${label}`}
          disabled={value >= max}
          onClick={() => setValue(value + 1)}
        >
          <Plus size={16} aria-hidden="true" />
        </Button>
      </div>
      <span style={{ color: 'var(--ww-text-muted)', fontSize: 'var(--ww-text-caption-size)' }}>
        可调范围 {min}–{max}
      </span>
      <FieldError issue={issue} />
    </label>
  );
}

function PlayersStep({
  draft,
  catalog,
  issues,
  update,
  onNext,
  showActions = true,
}: {
  draft: WizardDraft;
  catalog: RoomCreationCatalog;
  issues: WizardIssue[];
  update: (patch: Partial<WizardDraft>) => void;
  onNext: () => void;
  showActions?: boolean;
}) {
  const issueFor = (path: string) => issues.find((candidate) => candidate.path === path);
  const selectedPreset = presetFor(catalog, draft.maxPlayers);
  const updateMode = (mode: WizardDraft['mode']) => {
    if (mode === 'human') update({ mode, aiFillPolicy: 'none', computerSeats: 0, minHumanPlayers: draft.maxPlayers });
    else if (mode === 'quick_computer') update({ mode, aiFillPolicy: 'fill_to_max', computerSeats: 0, minHumanPlayers: 0 });
    else {
      // Keep the common mixed-room path to one decision: one human is enough
      // and every remaining seat is filled at start time.
      update({ mode, aiFillPolicy: 'fill_to_max', computerSeats: 0, minHumanPlayers: 1 });
    }
  };
  const updateCount = (maxPlayers: number) => {
    const nextPreset = presetFor(catalog, maxPlayers);
    const currentIsPreset = Boolean(draft.rolePresetId && selectedPreset?.id === draft.rolePresetId);
    const mixedComputerSeats = Math.min(
      Math.max(1, draft.computerSeats || Math.floor(maxPlayers / 3)),
      Math.max(1, maxPlayers - 1),
    );
    const mixedMinimumHumans = Math.min(
      Math.max(1, draft.minHumanPlayers),
      Math.max(1, maxPlayers - mixedComputerSeats),
    );
    const seatPatch = draft.mode === 'human'
      ? { minHumanPlayers: maxPlayers }
      : draft.mode === 'quick_computer'
        ? { minHumanPlayers: 0, computerSeats: 0 }
        : draft.aiFillPolicy === 'fixed'
          ? { computerSeats: mixedComputerSeats, minHumanPlayers: mixedMinimumHumans }
          : { minHumanPlayers: Math.min(Math.max(1, draft.minHumanPlayers), maxPlayers), computerSeats: 0 };
    if (currentIsPreset && nextPreset) {
      update({ maxPlayers, ...seatPatch, rolePresetId: nextPreset.id, roleSetup: { ...nextPreset.roleSetup }, rulesetId: nextPreset.rulesetId, rulesetVersion: nextPreset.rulesetVersion });
    } else {
      update({ maxPlayers, ...seatPatch, rolePresetId: undefined, ...(nextPreset ? { rulesetId: nextPreset.rulesetId, rulesetVersion: nextPreset.rulesetVersion } : {}) });
    }
  };
  const avatarOptions = [
    { id: 'avatar-player', asset: avatarAssetMap.player, label: '村民头像一' },
    { id: 'avatar-player-2', asset: avatarAssetMap.player, label: '村民头像二' },
    { id: 'avatar-player-3', asset: avatarAssetMap.player, label: '村民头像三' },
    { id: 'avatar-player-4', asset: avatarAssetMap.player, label: '村民头像四' },
    { id: 'avatar-player-5', asset: avatarAssetMap.player, label: '村民头像五' },
    { id: 'avatar-player-6', asset: avatarAssetMap.player, label: '村民头像六' },
  ];
  return (
    <div style={css('gap')}>
      <Card data-wizard-block="creator" tabIndex={-1}>
        <div className="v3-card-heading">
          <Users size={20} />
          <div><h2>基本信息</h2><p>这些信息用于创建房间。</p></div>
        </div>
        <div style={css('gap')}>
          <label className="v3-field">
            <span>显示名称</span>
            <Input id="wizard-creator-name" value={draft.creator.name} maxLength={catalog.limits.displayNameMax} aria-invalid={Boolean(issueFor('creator.name'))} aria-describedby={issueFor('creator.name') ? 'wizard-creator-name-error' : undefined} onChange={(event) => update({ creator: { ...draft.creator, name: event.target.value } })} />
            <FieldError issue={issueFor('creator.name')} />
          </label>
          <label className="v3-field">
            <span>房间名称</span>
            <Input id="wizard-room-name" value={draft.roomName} maxLength={catalog.limits.roomNameMax} aria-invalid={Boolean(issueFor('roomName'))} onChange={(event) => update({ roomName: event.target.value })} />
            <span style={{ color: 'var(--ww-text-muted)', fontSize: 'var(--ww-text-caption-size)' }}>{draft.roomName.length} / {catalog.limits.roomNameMax}</span>
            <FieldError issue={issueFor('roomName')} />
          </label>
          <div>
            <span className="v3-field__label">村民徽章</span>
      <div className="v3-wizard-avatar-options" aria-label="选择村民徽章">
              {avatarOptions.map(({ id: avatarId, asset, label }) => (
                <button key={avatarId} type="button" aria-label={label} aria-pressed={draft.creator.avatarId === avatarId} onClick={() => update({ creator: { ...draft.creator, avatarId } })} style={{ ...choiceStyle(draft.creator.avatarId === avatarId), flex: '0 0 52px', alignItems: 'center', padding: 'var(--ww-space-2)' }}>
                  <img className="v3-avatar-option" src={asset.src} alt="" aria-hidden="true" />
                </button>
              ))}
            </div>
            <FieldError issue={issueFor('creator.avatarId')} />
          </div>
        </div>
      </Card>

      <Card data-wizard-block="players" tabIndex={-1}>
        <div className="v3-card-heading"><Sparkles size={20} /><div><h2>选择房间模式</h2><p>先选今晚的节奏，之后再安排角色与规则。</p></div></div>
        <div className="v3-wizard-mode-grid">
          {(Object.keys(modeLabel) as WizardDraft['mode'][]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`v3-wizard-mode-card${draft.mode === mode ? ' is-selected' : ''}`}
              onClick={() => updateMode(mode)}
              aria-pressed={draft.mode === mode}
            >
              <span className="v3-wizard-mode-card__topline">
                <span className="v3-wizard-mode-card__icon" aria-hidden="true">
                  {mode === 'human' ? <Users size={20} /> : mode === 'mixed' ? <Sparkles size={20} /> : <Bot size={20} />}
                </span>
                <strong>{modeLabel[mode]}</strong>
                {mode === 'mixed' ? <Badge tone="success">推荐</Badge> : null}
                {draft.mode === mode ? <Check className="v3-wizard-mode-card__check" size={17} aria-label="已选择" /> : null}
              </span>
              <span className="v3-wizard-mode-card__description">{modeDescription[mode]}</span>
            </button>
          ))}
        </div>
        {draft.mode === 'quick_computer' ? <div className="v3-alert" style={{ marginTop: 'var(--ww-space-3)' }}>确认创建后会直接开局，你将进入全知监控，不会进入普通等待房。</div> : null}
      </Card>

      <Card data-wizard-block="players" tabIndex={-1}>
        <div className="v3-card-heading"><Users size={20} /><div><h2>总人数</h2><p>未启用的档位仍会展示，但不能创建。</p></div></div>
        <div className="v3-wizard-choice-grid v3-wizard-choice-grid--counts" role="group" aria-label="总人数">
          {catalog.playerCounts.map((count) => {
            const enabled = countEnabled(catalog, count);
            const preset = catalog.rolePresets.find((candidate) => candidate.playerCount === count);
            return <button key={count} type="button" disabled={!enabled} aria-pressed={draft.maxPlayers === count} title={!enabled ? (preset?.unavailableReason === 'RULESET_UNAVAILABLE' ? '规则准备中' : '暂不可用') : undefined} onClick={() => updateCount(count)} style={{ ...choiceStyle(draft.maxPlayers === count), flex: '1 1 80px', opacity: enabled ? 1 : .65 }}><strong>{count}人</strong><span style={{ color: enabled ? 'var(--ww-state-success)' : 'var(--ww-text-muted)', fontSize: 'var(--ww-text-caption-size)' }}>{enabled ? '可创建' : '规则准备中'}</span></button>;
          })}
        </div>
        <FieldError issue={issueFor('maxPlayers')} />
      </Card>

      <Card data-wizard-block="players" tabIndex={-1}>
        <div className="v3-card-heading"><Users size={20} /><div><h2>席位分配</h2><p>角色总数会在下一步与总席位核对。</p></div></div>
        {draft.mode === 'human' ? <p>朋友房：最低真人锁定为{draft.maxPlayers}人，电脑席锁定为0。</p> : null}
        {draft.mode === 'quick_computer' ? <p>快速电脑局：最低真人锁定为0，创建时会自动补满{draft.maxPlayers}个电脑席。</p> : null}
        {draft.mode === 'mixed' ? <div style={css('gap')}>
          <div className="v3-wizard-choice-grid" role="group" aria-label="电脑席补位方式">
            <button type="button" aria-pressed={draft.aiFillPolicy === 'fixed'} onClick={() => {
              const computerSeats = Math.max(1, Math.min(draft.maxPlayers - 1, draft.computerSeats || Math.floor(draft.maxPlayers / 3)));
              const minHumanPlayers = Math.min(Math.max(1, draft.minHumanPlayers), draft.maxPlayers - computerSeats);
              update({ aiFillPolicy: 'fixed', computerSeats, minHumanPlayers });
            }} style={choiceStyle(draft.aiFillPolicy === 'fixed')}><strong>按预设电脑席</strong><span>电脑席与最低真人都可单独调整。</span></button>
            <button type="button" aria-pressed={draft.aiFillPolicy === 'fill_to_max'} onClick={() => update({ aiFillPolicy: 'fill_to_max', computerSeats: 0 })} style={choiceStyle(draft.aiFillPolicy === 'fill_to_max')}><strong>开局时补满</strong><span>电脑数量按开局时的真人席位实时估算。</span></button>
          </div>
          {draft.aiFillPolicy === 'fixed' ? (
            <div className="v3-seat-steppers">
              <SeatStepper
                label="最低真人数"
                value={draft.minHumanPlayers}
                min={1}
                max={Math.max(1, draft.maxPlayers - draft.computerSeats)}
                issue={issueFor('minHumanPlayers')}
                onChange={(value) => update({ minHumanPlayers: value })}
              />
              <SeatStepper
                label="电脑席数量"
                value={draft.computerSeats}
                min={1}
                max={Math.max(1, draft.maxPlayers - draft.minHumanPlayers)}
                issue={issueFor('computerSeats')}
                onChange={(value) => update({ computerSeats: value })}
              />
            </div>
          ) : (
            <div className="v3-seat-steppers">
            <SeatStepper
              label="最低真人数"
              value={draft.minHumanPlayers}
              min={1}
              max={draft.maxPlayers}
              issue={issueFor('minHumanPlayers')}
              onChange={(value) => update({ minHumanPlayers: value })}
            />
            </div>
          )}
          {draft.aiFillPolicy === 'fixed' ? <p style={{ margin: 0, color: 'var(--ww-text-muted)' }}>最低真人数 + 电脑席数量不能超过{draft.maxPlayers}个总席位。</p> : null}
        </div> : null}
        <SeatPreview draft={draft} />
      </Card>

      {showActions ? <WizardActions onNext={onNext} nextLabel="继续选择角色" /> : null}
    </div>
  );
}

function RolesStep({
  draft,
  catalog,
  issues,
  update,
  onBack,
  onNext,
  showActions = true,
}: {
  draft: WizardDraft;
  catalog: RoomCreationCatalog;
  issues: WizardIssue[];
  update: (patch: Partial<WizardDraft>) => void;
  onBack: () => void;
  onNext: () => void;
  showActions?: boolean;
}) {
  const matchingPresets = catalog.rolePresets.filter((preset) => preset.playerCount === draft.maxPlayers);
  const custom = !draft.rolePresetId;
  const total = roleSetupTotal(draft.roleSetup);
  const diff = draft.maxPlayers - total;
  const issueFor = (role: string) => issues.find((candidate) => candidate.path === `roleSetup.${role}`) || (role === 'summary' ? issues.find((candidate) => candidate.path === 'roleSetup') : undefined);
  const setRoleCount = (role: (typeof ROLE_KEYS)[number], amount: number) => update({ rolePresetId: undefined, roleSetup: { ...draft.roleSetup, [role]: amount } });
  return (
    <div style={css('gap')}>
      <Card data-wizard-block="roleSetup" tabIndex={-1}>
        <div className="v3-card-heading"><Sparkles size={20} /><div><h2>选择角色预设</h2><p>预设与可用角色上下限均来自服务端目录。</p></div></div>
        <div style={row}>
          {matchingPresets.map((preset) => <button key={preset.id} type="button" disabled={!preset.enabled} aria-pressed={draft.rolePresetId === preset.id} onClick={() => update({ rolePresetId: preset.id, roleSetup: { ...preset.roleSetup }, rulesetId: preset.rulesetId, rulesetVersion: preset.rulesetVersion })} style={choiceStyle(draft.rolePresetId === preset.id)}><strong>{preset.name}</strong><span>规则版本 {preset.rulesetVersion}</span></button>)}
          <button type="button" aria-pressed={custom} onClick={() => update({ rolePresetId: undefined })} style={choiceStyle(custom)}><strong>自定义</strong><span>按目录上下限调整数量</span></button>
        </div>
      </Card>

      <Card data-wizard-block="roleSetup" tabIndex={-1}>
        <div style={{ ...row, justifyContent: 'space-between', borderBottom: '1.5px solid var(--ww-border-default)', paddingBottom: 'var(--ww-space-4)' }}>
          <strong>角色总数：{total} / {draft.maxPlayers}</strong>
          <Badge tone={diff === 0 ? 'success' : 'danger'}>{diff === 0 ? '配置完整' : diff > 0 ? `还差${diff}个` : `多出${Math.abs(diff)}个`}</Badge>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--ww-space-3)', marginTop: 'var(--ww-space-4)' }}>
          {ROLE_KEYS.map((role) => {
            const value = draft.roleSetup[role] ?? 0;
            const limit = catalog.roleLimits[role];
            return <div key={role}>
              <RoleCard role={role} name={ROLE_LABELS[role]} faction={role === 'wolf' ? '狼人阵营' : '好人阵营'} factionTone={role === 'wolf' ? 'wolf' : 'village'} description={ROLE_DESCRIPTIONS[role]} count={value} />
              {custom ? <div style={{ ...row, justifyContent: 'center', marginTop: 'calc(-1 * var(--ww-space-3))', position: 'relative' }}>
                <Button variant="icon" aria-label={`减少${ROLE_LABELS[role]}`} disabled={Boolean(limit && value <= limit.min)} onClick={() => setRoleCount(role, Math.max(limit?.min ?? 0, value - 1))}><Minus size={16} /></Button>
                <span className="v3-numeric" aria-label={`${ROLE_LABELS[role]}数量`}>{value}</span>
                <Button variant="icon" aria-label={`增加${ROLE_LABELS[role]}`} disabled={Boolean(limit && value >= limit.max)} onClick={() => setRoleCount(role, Math.min(limit?.max ?? draft.maxPlayers, value + 1))}><Plus size={16} /></Button>
              </div> : null}
              <FieldError issue={issueFor(role)} />
            </div>;
          })}
        </div>
        <FieldError issue={issueFor('summary')} />
      </Card>
      {showActions ? <WizardActions onBack={onBack} onNext={onNext} nextLabel="继续选择规则" /> : null}
    </div>
  );
}

function RulesStep({
  draft,
  issues,
  update,
  onBack,
  onNext,
  showActions = true,
}: {
  draft: WizardDraft;
  issues: WizardIssue[];
  update: (patch: Partial<WizardDraft>) => void;
  onBack: () => void;
  onNext: () => void;
  showActions?: boolean;
}) {
  const [rulesOpen, setRulesOpen] = useState(false);
  const issueFor = (path: string) => issues.find((candidate) => candidate.path === path);
  return (
    <div style={css('gap')}>
      <Card data-wizard-block="rules" tabIndex={-1}>
        <div className="v3-card-heading"><Sparkles size={20} /><div><h2>对局规则</h2><p>规则内容会在创建时再次确认。</p></div></div>
        <div style={css('gap')}>
          <div style={{ ...row, justifyContent: 'space-between' }}><span>当前规则集</span><strong>{draft.rulesetVersion ? `V3.1 · ${draft.rulesetVersion}` : '尚未选择'}</strong></div>
          <p style={{ margin: 0, color: 'var(--ww-text-muted)' }}>夜间行动顺序、角色能力、发言与投票规则均按这个版本执行。</p>
          <Button variant="secondary" onClick={() => setRulesOpen(true)}>查看完整规则</Button>
        </div>
        <FieldError issue={issueFor('rulesetId')} />
      </Card>

      <Modal
        open={rulesOpen}
        title="完整规则"
        context={draft.rulesetVersion ? `当前规则版本：${draft.rulesetVersion}` : undefined}
        onClose={() => setRulesOpen(false)}
      >
        <div className="v3-rule-dialog">
          <p>每位玩家的身份会在开局后私密发放。夜间按角色顺序行动，白天依次发言并投票。</p>
          <ul>
            <li>狼人阵营共同决定夜间目标，好人阵营通过发言和投票寻找狼人。</li>
            <li>房主会在真人玩家完成准备、人数和角色检查通过后开始对局。</li>
            <li>具体行动是否可用，以房间当前阶段显示的操作为准。</li>
          </ul>
        </div>
      </Modal>

      <Card data-wizard-block="rules" tabIndex={-1}>
        <div className="v3-card-heading"><Users size={20} /><div><h2>房间规则</h2><p>默认设置已适合直接开局，需要时再展开调整。</p></div></div>
        <div className="v3-wizard-settings-summary">
          <span><strong>{draft.visibility === 'listed' ? '大厅可见' : '仅凭邀请'}</strong> · {strategyLabel[draft.aiFillPolicy]}</span>
          <span>在线真人准备后由房主开局 · {draft.reviewEnabled ? (draft.reviewMode === 'ai' ? '开启 AI 复盘' : '开启复盘') : '关闭复盘'}</span>
        </div>
        <details className="v3-wizard-advanced">
          <summary>调整可见性、观战与复盘</summary>
          <div style={css('gap')}>
            <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="v3-field__label">房间可见性</legend>
              <div className="v3-wizard-choice-grid">
                <button type="button" aria-pressed={draft.visibility === 'invite_only'} onClick={() => update({ visibility: 'invite_only' })} style={choiceStyle(draft.visibility === 'invite_only')}><strong>仅凭邀请</strong><span>需要房间码与邀请口令。</span></button>
                <button type="button" aria-pressed={draft.visibility === 'listed'} onClick={() => update({ visibility: 'listed' })} style={choiceStyle(draft.visibility === 'listed')}><strong>大厅可见</strong><span>可以在大厅看到房间摘要。</span></button>
              </div>
              <FieldError issue={issueFor('visibility')} />
            </fieldset>
            {draft.mode !== 'human' ? <p style={{ margin: 0, color: 'var(--ww-text-muted)' }}>创建后可在等待房的“电脑玩家设置”中配置模型与安全凭据。</p> : null}
            <label style={row}><input type="checkbox" checked={draft.allowPublicSpectators} onChange={(event) => update({ allowPublicSpectators: event.target.checked })} />允许公开观战<FieldError issue={issueFor('allowPublicSpectators')} /></label>
            <label style={row}><input type="checkbox" checked={draft.reviewEnabled} onChange={(event) => update({ reviewEnabled: event.target.checked })} />对局结束后开启复盘<FieldError issue={issueFor('reviewEnabled')} /></label>
            {draft.reviewEnabled ? (
              <label style={row}><input type="checkbox" checked={draft.reviewMode === 'ai'} onChange={(event) => update({ reviewMode: event.target.checked ? 'ai' : 'rules' })} />使用 AI 生成复盘总结<span style={{ color: 'var(--ww-text-muted)' }}>无 LLM Key 时自动保留上帝视角，不显示 AI 文案。</span></label>
            ) : null}
          </div>
        </details>
      </Card>
      {showActions ? <WizardActions onBack={onBack} onNext={onNext} nextLabel="查看确认" /> : null}
    </div>
  );
}

function ConfirmStep({
  draft,
  issues,
  busy,
  onBack,
  onEdit,
  onCreate,
  compact = false,
}: {
  draft: WizardDraft;
  issues: WizardIssue[];
  busy: boolean;
  onBack: () => void;
  onEdit: (step: WizardStep) => void;
  onCreate: () => void;
  compact?: boolean;
}) {
  const issueFor = (step: WizardStep) => issues.find((candidate) => candidate.step === step || (step === 'players' && candidate.step === 'rules') || (step === 'roles' && candidate.step === 'confirm'));
  const expectedComputerSeats = draft.aiFillPolicy === 'fill_to_max' ? Math.max(0, draft.maxPlayers - draft.minHumanPlayers) : draft.computerSeats;
  return (
    <div style={css('gap')}>
      {!compact ? <Card data-wizard-block="players" tabIndex={-1}>
        <div style={{ ...row, justifyContent: 'space-between' }}><div><h2 style={{ margin: 0 }}>房间与人数</h2><p style={{ margin: 'var(--ww-space-2) 0 0' }}>{draft.roomName} · {modeLabel[draft.mode]} · {draft.maxPlayers}个席位</p><p style={{ margin: 0, color: 'var(--ww-text-muted)' }}>{expectedComputerSeats}个电脑席 · 至少{draft.minHumanPlayers}名真人</p>{draft.mode !== 'human' ? <p style={{ margin: 0, color: 'var(--ww-text-muted)' }}>电脑玩家参数将在等待房由受权房主配置。</p> : null}</div><Button variant="quiet" onClick={() => onEdit('players')}>修改</Button></div>
        <FieldError issue={issueFor('players')} />
      </Card> : null}
      {!compact ? <Card data-wizard-block="roleSetup" tabIndex={-1}>
        <div style={{ ...row, justifyContent: 'space-between' }}><div><h2 style={{ margin: 0 }}>角色配置</h2><p style={{ margin: 'var(--ww-space-2) 0 0' }}>{ROLE_KEYS.map((role) => `${ROLE_LABELS[role]}${draft.roleSetup[role]}`).join(' · ')}</p><p style={{ margin: 0, color: 'var(--ww-text-muted)' }}>共{roleSetupTotal(draft.roleSetup)}个角色 · 规则版本 {draft.rulesetVersion || '未选择'}</p></div><Button variant="quiet" onClick={() => onEdit('roles')}>修改</Button></div>
        <FieldError issue={issueFor('roles')} />
      </Card> : null}
      {!compact ? <Card data-wizard-block="rules" tabIndex={-1}>
        <div style={{ ...row, justifyContent: 'space-between' }}><div><h2 style={{ margin: 0 }}>房间规则</h2><p style={{ margin: 'var(--ww-space-2) 0 0' }}>{draft.visibility === 'listed' ? '大厅可见' : '仅凭邀请'} · {strategyLabel[draft.aiFillPolicy]} · {draft.allowPublicSpectators ? '允许公开观战' : '不开放公开观战'} · {draft.reviewEnabled ? (draft.reviewMode === 'ai' ? '开启 AI 复盘' : '开启复盘') : '关闭复盘'}</p><p style={{ margin: 0, color: 'var(--ww-text-muted)' }}>所有在线真人玩家准备后，由房主开局。</p></div><Button variant="quiet" onClick={() => onEdit('players')}>修改</Button></div>
        <FieldError issue={issueFor('players')} />
      </Card> : null}
      <Card tone="raised" data-wizard-block="confirm" tabIndex={-1}>
        {compact ? <>
          <strong>规则版本：{draft.rulesetVersion || '未选择'} · {draft.roomName || '未命名房间'} · {draft.maxPlayers}个席位</strong>
          {draft.mode !== 'human' ? <p style={{ margin: 'var(--ww-space-2) 0 0', color: 'var(--ww-text-muted)' }}>创建后可在等待房的“电脑玩家设置”中配置电脑玩家。</p> : null}
        </> : null}
        <strong>{draft.mode === 'quick_computer' ? '创建后立即开局，你将进入全知监控。' : '创建后进入等待房，邀请朋友入座。'}</strong>
        <div className="v3-wizard-confirm-actions" style={{ ...row, justifyContent: 'space-between', marginTop: 'var(--ww-space-4)' }}>
          <Button variant="secondary" onClick={onBack} disabled={busy}><ArrowLeft size={17} />返回修改</Button>
          <Button size="action" onClick={onCreate} disabled={busy}>{busy ? '正在创建……' : draft.mode === 'quick_computer' ? '创建并开始电脑局' : '创建并进入等待房'}<ArrowRight size={17} /></Button>
        </div>
      </Card>
    </div>
  );
}

function PlayersAndRulesStep({
  draft,
  catalog,
  issues,
  update,
  onNext,
}: {
  draft: WizardDraft;
  catalog: RoomCreationCatalog;
  issues: WizardIssue[];
  update: (patch: Partial<WizardDraft>) => void;
  onNext: () => void;
}) {
  return (
    <div style={css('gap')}>
      <PlayersStep draft={draft} catalog={catalog} issues={issues} update={update} onNext={onNext} showActions={false} />
      <RulesStep draft={draft} issues={issues} update={update} onBack={() => undefined} onNext={onNext} showActions={false} />
      <WizardActions onNext={onNext} nextLabel="继续选择角色" />
    </div>
  );
}

function RolesAndConfirmStep({
  draft,
  catalog,
  issues,
  busy,
  update,
  onBack,
  onCreate,
}: {
  draft: WizardDraft;
  catalog: RoomCreationCatalog;
  issues: WizardIssue[];
  busy: boolean;
  update: (patch: Partial<WizardDraft>) => void;
  onBack: () => void;
  onCreate: () => void;
}) {
  return (
    <div style={css('gap')}>
      <RolesStep draft={draft} catalog={catalog} issues={issues} update={update} onBack={onBack} onNext={onBack} showActions={false} />
      <ConfirmStep draft={draft} issues={issues} busy={busy} onBack={onBack} onEdit={(step) => step === 'players' ? onBack() : undefined} onCreate={onCreate} compact />
    </div>
  );
}

function WizardActions({ onBack, onNext, nextLabel }: { onBack?: () => void; onNext: () => void; nextLabel: string }) {
  return <div className="v3-wizard-actions" style={{ ...row, justifyContent: 'space-between' }}><span style={{ color: 'var(--ww-text-muted)', fontSize: 'var(--ww-text-caption-size)' }}>草稿会自动保存在本次浏览会话中。</span><div style={row}>{onBack ? <Button variant="secondary" onClick={onBack}><ArrowLeft size={17} />上一步</Button> : null}<Button size="action" onClick={onNext}>{nextLabel}<ArrowRight size={17} /></Button></div></div>;
}

export function RoomWizardPage() {
  const navigate = useNavigate();
  const { step: rawStep } = useParams<{ step: string }>();
  const catalog = useV3Store((state) => state.catalog);
  const catalogStatus = useV3Store((state) => state.catalogStatus);
  const catalogError = useV3Store((state) => state.catalogError);
  const connected = useV3Store((state) => state.connected);
  const error = useV3Store((state) => state.error);
  const refreshCatalog = useV3Store((state) => state.refreshCatalog);
  const createRoomWithOptions = useV3Store((state) => state.createRoomWithOptions);
  const [draft, setDraft] = useState<WizardDraft | null>(null);
  const [serverIssues, setServerIssues] = useState<WizardIssue[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!catalog && catalogStatus === 'idle') void refreshCatalog();
  }, [catalog, catalogStatus, refreshCatalog]);

  useEffect(() => {
    if (!catalog || draft) return;
    const saved = readWizardDraft(storageTarget());
    const next = saved
      ? { ...cloneDraft(saved), catalogVersion: catalog.catalogVersion }
      : createInitialDraft(catalog, readPlayerNickname());
    setDraft(next);
    writeWizardDraft(storageTarget(), next);
  }, [catalog, draft]);

  // Old /players, /roles, /rules and /confirm links intentionally resolve to
  // this single settings surface. The route remains deep-linkable, but the
  // user no longer has to walk through separate wizard pages.
  useEffect(() => {
    if (!rawStep || rawStep.toLowerCase() === 'settings') return;
    if (normalizeWizardStep(rawStep)) {
      navigate('/rooms/new/settings', { replace: true });
      return;
    }
    navigate('/rooms/new/settings', { replace: true });
  }, [navigate, rawStep]);

  const update = (patch: Partial<WizardDraft>) => {
    setDraft((current) => {
      if (!current) return current;
      const next = cloneDraft({ ...current, ...patch });
      writeWizardDraft(storageTarget(), next);
      setServerIssues([]);
      return next;
    });
  };

  const create = async () => {
    if (!draft || !catalog || busy) return;
    const issues = validateWizardStep(draft, 'confirm', catalog);
    if (issues.length > 0) {
      setServerIssues([]);
      const block = document.querySelector<HTMLElement>(`[data-wizard-block="${issueBlock(issues[0].path)}"]`);
      block?.focus({ preventScroll: true });
      block?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    writePlayerNickname(draft.creator.name);
    setBusy(true);
    const response = await createRoomWithOptions(optionsFromDraft(draft));
    if (response.ok === false) {
      const mapped = serverIssuesToWizardIssues('issues' in response ? response.issues : undefined);
      const nextIssues = mapped.length > 0 ? mapped : [{ path: '', message: messageForIssue(response.code), step: codeFallbackStep(response.code), errorCode: response.code }];
      setServerIssues(nextIssues);
      navigate(wizardPathForStep(nextIssues[0].step));
      setBusy(false);
      return;
    }
    clearWizardDraft(storageTarget());
    navigate(`/rooms/${encodeURIComponent(response.room.code)}/waiting`, { replace: true });
  };

  if (!catalog || !draft) {
    const failed = catalogStatus === 'error';
    return <AppShell title="创建房间" eyebrow="开房向导" connected={connected}>
      <Card className="v3-empty-state" aria-live="polite">
        <strong>{failed ? '房间目录加载失败' : '正在载入房间目录'}</strong>
        <span>{failed ? (catalogError ?? '暂时无法读取房间目录，请重试。') : '正在读取可用人数与规则，请稍候。'}</span>
        {failed ? <div className="v3-action-stack">
          <Button onClick={() => void refreshCatalog({ force: true })}>重新载入目录</Button>
          <Button variant="quiet" onClick={() => navigate('/lobby')}>返回大厅</Button>
        </div> : null}
      </Card>
    </AppShell>;
  }

  const allIssues = useMemo(
    () => issuesForStep(draft, 'roles', catalog),
    [catalog, draft],
  );
  const issuesFor = (step: WizardStep): WizardIssue[] => [
    ...allIssues.filter((issue) => (step === 'players'
      ? issue.step === 'players' || issue.step === 'rules'
      : issue.step === 'roles')),
    ...serverIssues.filter((issue) => step === 'players'
      ? issue.step === 'players' || issue.step === 'rules'
      : issue.step === 'roles'),
  ];

  return (
    <AppShell title="房间设置" eyebrow="狼人杀·月光森林" connected={connected}>
      <div className="v3-page-heading">
        <div><span>创建房间 · 设置完成后直接入座</span><h1>{draft.roomName || '未命名房间'}</h1></div>
        <Badge tone="info">房间设置</Badge>
      </div>
      {serverIssues.length > 0 ? <div className="v3-alert v3-alert--error" role="alert">创建未完成，请按提示修改；你的设置已保留。</div> : null}
      {error && serverIssues.length === 0 ? <div className="v3-alert v3-alert--error" role="alert">{error}</div> : null}
      <div className="v3-wizard-grid v3-room-settings-grid" style={grid}>
        <section className="v3-wizard-main" aria-label="房间设置">
          <PlayersStep draft={draft} catalog={catalog} issues={issuesFor('players')} update={update} onNext={() => undefined} showActions={false} />
          <RolesStep draft={draft} catalog={catalog} issues={issuesFor('roles')} update={update} onBack={() => undefined} onNext={() => undefined} showActions={false} />
          <RulesStep draft={draft} issues={issuesFor('players')} update={update} onBack={() => undefined} onNext={() => undefined} showActions={false} />
          <Card tone="raised" className="v3-room-settings-submit">
            <div>
              <strong>设置完成？</strong>
              <p>创建后直接进入统一等待房，房主可以继续调整开局前设置。</p>
            </div>
            <div className="v3-wizard-confirm-actions" style={{ ...row, justifyContent: 'space-between' }}>
              <Button variant="secondary" onClick={() => { clearWizardDraft(storageTarget()); navigate('/lobby'); }} disabled={busy}>退出</Button>
              <Button size="action" onClick={() => void create()} disabled={busy || allIssues.length > 0}>
                {busy ? '正在创建……' : draft.mode === 'quick_computer' ? '创建并开始电脑局' : '创建并进入等待房'}<ArrowRight size={17} />
              </Button>
            </div>
          </Card>
        </section>
        <aside className="v3-wizard-preview" aria-label="本局预览">
          <RoomPreview draft={draft} />
          <Button variant="quiet" onClick={() => { clearWizardDraft(storageTarget()); navigate('/lobby'); }} style={{ marginTop: 'var(--ww-space-3)', width: '100%' }}>退出并清除草稿</Button>
        </aside>
      </div>
    </AppShell>
  );
}
