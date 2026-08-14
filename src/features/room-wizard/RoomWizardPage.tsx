import {
  ArrowLeft,
  ArrowRight,
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
  gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)',
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
  human: '真人加入后一起准备，默认不补电脑。',
  mixed: '预留电脑席，也可以邀请真人入座。',
  quick_computer: '创建后立即开局，你将进入全知监控。',
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
  if (code === 'RULESET_UNAVAILABLE') return 'rules';
  return 'confirm';
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
          const local = item.id === 'confirm'
            ? validateWizardStep(draft, 'confirm', catalog)
            : issuesForStep(draft, item.id, catalog);
          const errorCount = (item.id === 'confirm' ? local : local.filter((candidate) => candidate.step === item.id)).length +
            (item.id === 'confirm' ? serverIssues.length : serverIssues.filter((candidate) => candidate.step === item.id).length);
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
    <Card>
      <div className="v3-card-heading">
        <Sparkles size={20} />
        <div>
          <h2>本局预览</h2>
          <p>这里只展示你的配置草稿，创建后以服务端回显为准。</p>
        </div>
      </div>
      <div style={css('gap')}>
        <strong>{draft.roomName || '未命名房间'}</strong>
        <span>{modeLabel[draft.mode]} · {draft.maxPlayers || '—'}个席位</span>
        <span>{expectedComputerSeats}个电脑席 · 至少{draft.minHumanPlayers}名真人</span>
        <span>规则版本：{draft.rulesetVersion || '尚未选择'}</span>
        <span>补位：{strategyLabel[draft.aiFillPolicy]}</span>
      </div>
      <div style={{ ...row, borderTop: '1.5px solid var(--ww-border-default)', paddingTop: 'var(--ww-space-4)' }}>
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
    <div style={{ ...css('gap'), marginTop: 'var(--ww-space-4)' }}>
      <div style={row}>
        <strong>席位投影</strong>
        <span style={{ color: 'var(--ww-text-muted)' }}>预计 {humanSeats} 真人席 · {expectedComputerSeats} 电脑席</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--ww-space-2)' }}>
        {Array.from({ length: Math.max(0, draft.maxPlayers) }, (_, index) => {
          const isComputer = index >= humanSeats;
          return (
            <Seat
              key={index}
              seatNumber={index + 1}
              kind={isComputer ? 'computer' : index === 0 && draft.mode !== 'quick_computer' ? 'player' : 'empty'}
              presence={isComputer ? 'waiting' : index === 0 && draft.mode !== 'quick_computer' ? 'online' : 'idle'}
              name={isComputer ? '预计电脑席' : index === 0 && draft.mode !== 'quick_computer' ? draft.creator.name || '创建者' : undefined}
              meta={isComputer ? '创建时由服务端安排' : undefined}
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

function PlayersStep({
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
  const issueFor = (path: string) => issues.find((candidate) => candidate.path === path);
  const selectedPreset = presetFor(catalog, draft.maxPlayers);
  const updateMode = (mode: WizardDraft['mode']) => {
    if (mode === 'human') update({ mode, aiFillPolicy: 'none', computerSeats: 0, minHumanPlayers: draft.maxPlayers });
    else if (mode === 'quick_computer') update({ mode, aiFillPolicy: 'fill_to_max', computerSeats: 0, minHumanPlayers: 0 });
    else {
      const seats = Math.max(1, Math.min(Math.max(1, draft.maxPlayers - 1), draft.computerSeats || Math.floor(draft.maxPlayers / 3)));
      update({ mode, aiFillPolicy: 'fixed', computerSeats: seats, minHumanPlayers: draft.maxPlayers - seats });
    }
  };
  const updateCount = (maxPlayers: number) => {
    const nextPreset = presetFor(catalog, maxPlayers);
    const currentIsPreset = Boolean(draft.rolePresetId && selectedPreset?.id === draft.rolePresetId);
    const seatPatch = draft.mode === 'human'
      ? { minHumanPlayers: maxPlayers }
      : draft.mode === 'quick_computer'
        ? { minHumanPlayers: 0, computerSeats: 0 }
        : draft.aiFillPolicy === 'fixed'
          ? { computerSeats: Math.min(Math.max(1, draft.computerSeats), Math.max(1, maxPlayers - 1)), minHumanPlayers: maxPlayers - Math.min(Math.max(1, draft.computerSeats), Math.max(1, maxPlayers - 1)) }
          : { minHumanPlayers: Math.min(Math.max(1, draft.minHumanPlayers), maxPlayers), computerSeats: 0 };
    if (currentIsPreset && nextPreset) {
      update({ maxPlayers, ...seatPatch, rolePresetId: nextPreset.id, roleSetup: { ...nextPreset.roleSetup }, rulesetId: nextPreset.rulesetId, rulesetVersion: nextPreset.rulesetVersion });
    } else {
      update({ maxPlayers, ...seatPatch, rolePresetId: undefined, ...(nextPreset ? { rulesetId: nextPreset.rulesetId, rulesetVersion: nextPreset.rulesetVersion } : {}) });
    }
  };
  const avatarIds = ['avatar-player', 'avatar-moon', 'avatar-leaf', 'avatar-star', 'avatar-acorn', 'avatar-lantern'];
  return (
    <div style={css('gap')}>
      <Card data-wizard-block="creator" tabIndex={-1}>
        <div className="v3-card-heading">
          <Users size={20} />
          <div><h2>基本信息</h2><p>这些信息会随创建请求发送给服务端。</p></div>
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
            <div style={row} aria-label="选择村民徽章">
              {avatarIds.map((avatarId, index) => (
                <button key={avatarId} type="button" aria-label={`村民徽章${index + 1}`} aria-pressed={draft.creator.avatarId === avatarId} onClick={() => update({ creator: { ...draft.creator, avatarId } })} style={{ ...choiceStyle(draft.creator.avatarId === avatarId), flex: '0 0 52px', alignItems: 'center', padding: 'var(--ww-space-2)' }}>
                  <span aria-hidden="true" style={{ fontSize: 22 }}>民</span>
                </button>
              ))}
            </div>
            <FieldError issue={issueFor('creator.avatarId')} />
          </div>
        </div>
      </Card>

      <Card data-wizard-block="players" tabIndex={-1}>
        <div className="v3-card-heading"><Sparkles size={20} /><div><h2>选择房间模式</h2><p>先选今晚的节奏，之后再安排角色与规则。</p></div></div>
        <div style={row}>
          {(Object.keys(modeLabel) as WizardDraft['mode'][]).map((mode) => (
            <button key={mode} type="button" onClick={() => updateMode(mode)} aria-pressed={draft.mode === mode} style={choiceStyle(draft.mode === mode)}>
              <strong>{modeLabel[mode]}</strong><span style={{ color: 'var(--ww-text-muted)', fontSize: 'var(--ww-text-caption-size)' }}>{modeDescription[mode]}</span>
            </button>
          ))}
        </div>
        {draft.mode === 'quick_computer' ? <div className="v3-alert" style={{ marginTop: 'var(--ww-space-3)' }}>确认创建后会直接开局，你将进入全知监控，不会进入普通等待房。</div> : null}
      </Card>

      <Card data-wizard-block="players" tabIndex={-1}>
        <div className="v3-card-heading"><Users size={20} /><div><h2>总人数</h2><p>未启用的档位仍会展示，但不能创建。</p></div></div>
        <div style={row} role="group" aria-label="总人数">
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
        {draft.mode === 'human' ? <p>朋友房：真人需要坐满{draft.maxPlayers}个席位后才能开局。</p> : null}
        {draft.mode === 'quick_computer' ? <p>快速电脑局：服务端会在创建时补满{draft.maxPlayers}个电脑席。</p> : null}
        {draft.mode === 'mixed' ? <div style={css('gap')}>
          <div style={row}>
            <button type="button" aria-pressed={draft.aiFillPolicy === 'fixed'} onClick={() => update({ aiFillPolicy: 'fixed', computerSeats: Math.max(1, Math.min(draft.maxPlayers - 1, draft.computerSeats || 1)), minHumanPlayers: draft.maxPlayers - Math.max(1, Math.min(draft.maxPlayers - 1, draft.computerSeats || 1)) })} style={choiceStyle(draft.aiFillPolicy === 'fixed')}><strong>按预设电脑席</strong><span>预留电脑席，可邀请真人占用其余席位。</span></button>
            <button type="button" aria-pressed={draft.aiFillPolicy === 'fill_to_max'} onClick={() => update({ aiFillPolicy: 'fill_to_max', computerSeats: 0 })} style={choiceStyle(draft.aiFillPolicy === 'fill_to_max')}><strong>开局时补满</strong><span>电脑数量按开局时的真人席位实时估算。</span></button>
          </div>
          {draft.aiFillPolicy === 'fixed' ? <label className="v3-field" style={{ maxWidth: 240 }}><span>电脑席数量</span><Input type="number" min={1} max={Math.max(1, draft.maxPlayers - 1)} value={draft.computerSeats} onChange={(event) => { const value = Math.max(1, Math.min(Math.max(1, draft.maxPlayers - 1), Number(event.target.value) || 1)); update({ computerSeats: value, minHumanPlayers: draft.maxPlayers - value }); }} /><FieldError issue={issueFor('computerSeats')} /></label> : <label className="v3-field" style={{ maxWidth: 240 }}><span>最低真人数</span><Input type="number" min={1} max={draft.maxPlayers} value={draft.minHumanPlayers} onChange={(event) => update({ minHumanPlayers: Math.max(1, Math.min(draft.maxPlayers, Number(event.target.value) || 1)) })} /><FieldError issue={issueFor('minHumanPlayers')} /></label>}
        </div> : null}
        <SeatPreview draft={draft} />
      </Card>

      <WizardActions onNext={onNext} nextLabel="继续选择角色" />
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
}: {
  draft: WizardDraft;
  catalog: RoomCreationCatalog;
  issues: WizardIssue[];
  update: (patch: Partial<WizardDraft>) => void;
  onBack: () => void;
  onNext: () => void;
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
              <RoleCard name={ROLE_LABELS[role]} faction={role === 'wolf' ? '狼人阵营' : '好人阵营'} factionTone={role === 'wolf' ? 'wolf' : 'village'} description={ROLE_DESCRIPTIONS[role]} count={value} badge={role === 'wolf' ? '狼' : '民'} />
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
      <WizardActions onBack={onBack} onNext={onNext} nextLabel="继续选择规则" />
    </div>
  );
}

function RulesStep({
  draft,
  issues,
  update,
  onBack,
  onNext,
}: {
  draft: WizardDraft;
  issues: WizardIssue[];
  update: (patch: Partial<WizardDraft>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const issueFor = (path: string) => issues.find((candidate) => candidate.path === path);
  return (
    <div style={css('gap')}>
      <Card data-wizard-block="rules" tabIndex={-1}>
        <div className="v3-card-heading"><Sparkles size={20} /><div><h2>对局规则</h2><p>规则内容由服务端规则集提供，创建时会再次校验。</p></div></div>
        <div style={css('gap')}>
          <div style={{ ...row, justifyContent: 'space-between' }}><span>当前规则集</span><strong>{draft.rulesetVersion ? `V3.1 · ${draft.rulesetVersion}` : '尚未选择'}</strong></div>
          <p style={{ margin: 0, color: 'var(--ww-text-muted)' }}>夜间行动顺序、角色能力、发言与投票规则均按这个版本执行。</p>
          <Button variant="secondary" disabled>查看完整规则（创建后可查看）</Button>
        </div>
        <FieldError issue={issueFor('rulesetId')} />
      </Card>

      <Card data-wizard-block="rules" tabIndex={-1}>
        <div className="v3-card-heading"><Users size={20} /><div><h2>房间规则</h2><p>只展示当前服务端已接入的选项。</p></div></div>
        <div style={css('gap')}>
          <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="v3-field__label">房间可见性</legend>
            <div style={row}>
              <button type="button" aria-pressed={draft.visibility === 'invite_only'} onClick={() => update({ visibility: 'invite_only' })} style={choiceStyle(draft.visibility === 'invite_only')}><strong>仅凭邀请</strong><span>需要房间码与邀请口令。</span></button>
              <button type="button" aria-pressed={draft.visibility === 'listed'} onClick={() => update({ visibility: 'listed' })} style={choiceStyle(draft.visibility === 'listed')}><strong>大厅可见</strong><span>可以在大厅看到房间摘要。</span></button>
            </div>
            <FieldError issue={issueFor('visibility')} />
          </fieldset>
          <div style={{ ...row, justifyContent: 'space-between' }}><span>电脑补位</span><strong>{strategyLabel[draft.aiFillPolicy]}</strong></div>
          <div style={{ ...row, justifyContent: 'space-between' }}><span>准备规则</span><strong>所有在线真人玩家准备后，由房主开局</strong></div>
          <label style={row}><input type="checkbox" checked={draft.allowPublicSpectators} onChange={(event) => update({ allowPublicSpectators: event.target.checked })} />允许公开观战<FieldError issue={issueFor('allowPublicSpectators')} /></label>
          <label style={row}><input type="checkbox" checked={draft.reviewEnabled} onChange={(event) => update({ reviewEnabled: event.target.checked })} />对局结束后开启复盘<FieldError issue={issueFor('reviewEnabled')} /></label>
        </div>
      </Card>
      <WizardActions onBack={onBack} onNext={onNext} nextLabel="查看确认" />
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
}: {
  draft: WizardDraft;
  issues: WizardIssue[];
  busy: boolean;
  onBack: () => void;
  onEdit: (step: WizardStep) => void;
  onCreate: () => void;
}) {
  const issueFor = (step: WizardStep) => issues.find((candidate) => candidate.step === step);
  const expectedComputerSeats = draft.aiFillPolicy === 'fill_to_max' ? Math.max(0, draft.maxPlayers - draft.minHumanPlayers) : draft.computerSeats;
  return (
    <div style={css('gap')}>
      <Card data-wizard-block="players" tabIndex={-1}>
        <div style={{ ...row, justifyContent: 'space-between' }}><div><h2 style={{ margin: 0 }}>房间与人数</h2><p style={{ margin: 'var(--ww-space-2) 0 0' }}>{draft.roomName} · {modeLabel[draft.mode]} · {draft.maxPlayers}个席位</p><p style={{ margin: 0, color: 'var(--ww-text-muted)' }}>{expectedComputerSeats}个电脑席 · 至少{draft.minHumanPlayers}名真人</p></div><Button variant="quiet" onClick={() => onEdit('players')}>修改</Button></div>
        <FieldError issue={issueFor('players')} />
      </Card>
      <Card data-wizard-block="roleSetup" tabIndex={-1}>
        <div style={{ ...row, justifyContent: 'space-between' }}><div><h2 style={{ margin: 0 }}>角色配置</h2><p style={{ margin: 'var(--ww-space-2) 0 0' }}>{ROLE_KEYS.map((role) => `${ROLE_LABELS[role]}${draft.roleSetup[role]}`).join(' · ')}</p><p style={{ margin: 0, color: 'var(--ww-text-muted)' }}>共{roleSetupTotal(draft.roleSetup)}个角色 · 规则版本 {draft.rulesetVersion || '未选择'}</p></div><Button variant="quiet" onClick={() => onEdit('roles')}>修改</Button></div>
        <FieldError issue={issueFor('roles')} />
      </Card>
      <Card data-wizard-block="rules" tabIndex={-1}>
        <div style={{ ...row, justifyContent: 'space-between' }}><div><h2 style={{ margin: 0 }}>房间规则</h2><p style={{ margin: 'var(--ww-space-2) 0 0' }}>{draft.visibility === 'listed' ? '大厅可见' : '仅凭邀请'} · {strategyLabel[draft.aiFillPolicy]} · {draft.allowPublicSpectators ? '允许公开观战' : '不开放公开观战'} · {draft.reviewEnabled ? '开启复盘' : '关闭复盘'}</p><p style={{ margin: 0, color: 'var(--ww-text-muted)' }}>所有在线真人玩家准备后，由房主开局。</p></div><Button variant="quiet" onClick={() => onEdit('rules')}>修改</Button></div>
        <FieldError issue={issueFor('rules')} />
      </Card>
      <Card tone="raised" data-wizard-block="confirm" tabIndex={-1}>
        <strong>{draft.mode === 'quick_computer' ? '创建后立即开局，你将进入全知监控。' : '创建后进入等待房，邀请朋友入座。'}</strong>
        <div style={{ ...row, justifyContent: 'space-between', marginTop: 'var(--ww-space-4)' }}>
          <Button variant="secondary" onClick={onBack} disabled={busy}><ArrowLeft size={17} />返回修改</Button>
          <Button size="action" onClick={onCreate} disabled={busy}>{busy ? '正在创建……' : draft.mode === 'quick_computer' ? '创建并开始电脑局' : '创建并进入等待房'}<ArrowRight size={17} /></Button>
        </div>
      </Card>
    </div>
  );
}

function WizardActions({ onBack, onNext, nextLabel }: { onBack?: () => void; onNext: () => void; nextLabel: string }) {
  return <div style={{ ...row, justifyContent: 'space-between' }}><span style={{ color: 'var(--ww-text-muted)', fontSize: 'var(--ww-text-caption-size)' }}>草稿会自动保存在本次浏览会话中。</span><div style={row}>{onBack ? <Button variant="secondary" onClick={onBack}><ArrowLeft size={17} />上一步</Button> : null}<Button size="action" onClick={onNext}>{nextLabel}<ArrowRight size={17} /></Button></div></div>;
}

export function RoomWizardPage() {
  const navigate = useNavigate();
  const { step: rawStep } = useParams<{ step: string }>();
  const currentStep = normalizeWizardStep(rawStep) ?? 'players';
  const catalog = useV3Store((state) => state.catalog);
  const connected = useV3Store((state) => state.connected);
  const error = useV3Store((state) => state.error);
  const refreshCatalog = useV3Store((state) => state.refreshCatalog);
  const createRoomWithOptions = useV3Store((state) => state.createRoomWithOptions);
  const [draft, setDraft] = useState<WizardDraft | null>(null);
  const [serverIssues, setServerIssues] = useState<WizardIssue[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!catalog) void refreshCatalog();
  }, [catalog, refreshCatalog]);

  useEffect(() => {
    if (!catalog || draft) return;
    const saved = readWizardDraft(storageTarget());
    const next = saved
      ? { ...cloneDraft(saved), catalogVersion: catalog.catalogVersion }
      : createInitialDraft(catalog);
    setDraft(next);
    writeWizardDraft(storageTarget(), next);
  }, [catalog, draft]);

  useEffect(() => {
    if (!rawStep || !normalizeWizardStep(rawStep)) navigate(WIZARD_STEP_PATHS.players, { replace: true });
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

  const localIssues = useMemo(() => {
    if (!draft || !catalog) return [];
    return validateWizardStep(draft, currentStep, catalog);
  }, [catalog, currentStep, draft]);

  const visibleIssues = useMemo(
    () => currentStep === 'confirm'
      ? [...localIssues, ...serverIssues]
      : [
          ...localIssues.filter((item) => item.step === currentStep),
          ...serverIssues.filter((item) => item.step === currentStep),
        ],
    [currentStep, localIssues, serverIssues],
  );

  useEffect(() => {
    if (visibleIssues.length === 0 || typeof document === 'undefined') return;
    const block = document.querySelector<HTMLElement>(`[data-wizard-block="${issueBlock(visibleIssues[0].path)}"]`);
    block?.focus({ preventScroll: true });
    block?.scrollIntoView({ block: 'nearest' });
  }, [currentStep, visibleIssues]);

  useEffect(() => {
    if (!draft || !catalog || currentStep === 'players') return;
    const prior = WIZARD_STEPS.slice(0, stepIndex(currentStep));
    const firstInvalid = prior.find((item) => validateWizardStep(draft, item.id, catalog).length > 0);
    if (firstInvalid) navigate(WIZARD_STEP_PATHS[firstInvalid.id], { replace: true });
  }, [catalog, currentStep, draft, navigate]);

  const navigateStep = (target: WizardStep) => {
    if (!draft || !catalog) return;
    if (stepIndex(target) > stepIndex(currentStep)) {
      const firstInvalid = WIZARD_STEPS.slice(0, stepIndex(target)).find((item) => validateWizardStep(draft, item.id, catalog).length > 0);
      if (firstInvalid) {
        navigate(WIZARD_STEP_PATHS[firstInvalid.id]);
        return;
      }
    }
    navigate(WIZARD_STEP_PATHS[target]);
  };

  const continueStep = () => {
    if (!draft || !catalog) return;
    const issues = validateWizardStep(draft, currentStep, catalog);
    setServerIssues([]);
    if (issues.length > 0) {
      const first = issues[0];
      navigate(WIZARD_STEP_PATHS[first.step]);
      return;
    }
    const next = WIZARD_STEPS[stepIndex(currentStep) + 1];
    if (next) navigate(WIZARD_STEP_PATHS[next.id]);
  };

  const create = async () => {
    if (!draft || !catalog || busy) return;
    const issues = validateWizardStep(draft, 'confirm', catalog);
    if (issues.length > 0) {
      setServerIssues([]);
      navigate(WIZARD_STEP_PATHS[issues[0].step]);
      return;
    }
    setBusy(true);
    const response = await createRoomWithOptions(optionsFromDraft(draft));
    if (response.ok === false) {
      const mapped = serverIssuesToWizardIssues(response.issues);
      const nextIssues = mapped.length > 0 ? mapped : [{ path: '', message: messageForIssue(response.code), step: codeFallbackStep(response.code), errorCode: response.code }];
      setServerIssues(nextIssues);
      navigate(WIZARD_STEP_PATHS[nextIssues[0].step]);
      setBusy(false);
      return;
    }
    clearWizardDraft(storageTarget());
    navigate(`/rooms/${encodeURIComponent(response.room.code)}`, { replace: true });
  };

  if (!catalog || !draft) {
    return <AppShell title="创建房间" eyebrow="开房向导"><Card className="v3-empty-state" aria-live="polite"><strong>正在载入房间目录</strong><span>{error ?? '正在从服务端读取可用人数与规则，请稍候。'}</span></Card></AppShell>;
  }

  const pageTitle = WIZARD_STEPS.find((item) => item.id === currentStep)?.title ?? WIZARD_STEPS[0].title;
  return (
    <AppShell title="开房向导" eyebrow="狼人杀 V3.1" connected={connected}>
      <div className="v3-page-heading"><div><span>四步创建 · {draft.roomName || '未命名房间'}</span><h1>{pageTitle}</h1></div><Badge tone="info">创建设置</Badge></div>
      <WizardStepper current={currentStep} draft={draft} catalog={catalog} serverIssues={serverIssues} onNavigate={navigateStep} />
      {serverIssues.length > 0 ? <div className="v3-alert v3-alert--error" role="alert">创建未完成，请按提示修改；你的全部草稿已保留。</div> : null}
      {error && serverIssues.length === 0 ? <div className="v3-alert v3-alert--error" role="alert">{error}</div> : null}
      <div style={grid}>
        <section aria-label={`第${stepIndex(currentStep) + 1}步`}>
          {currentStep === 'players' ? <PlayersStep draft={draft} catalog={catalog} issues={visibleIssues} update={update} onNext={continueStep} /> : null}
          {currentStep === 'roles' ? <RolesStep draft={draft} catalog={catalog} issues={visibleIssues} update={update} onBack={() => navigateStep('players')} onNext={continueStep} /> : null}
          {currentStep === 'rules' ? <RulesStep draft={draft} issues={visibleIssues} update={update} onBack={() => navigateStep('roles')} onNext={continueStep} /> : null}
          {currentStep === 'confirm' ? <ConfirmStep draft={draft} issues={visibleIssues} busy={busy} onBack={() => navigateStep('rules')} onEdit={navigateStep} onCreate={() => void create()} /> : null}
        </section>
        <aside style={{ position: 'sticky', top: 'var(--ww-space-4)' }}><RoomPreview draft={draft} /><Button variant="quiet" onClick={() => { clearWizardDraft(storageTarget()); navigate('/lobby'); }} style={{ marginTop: 'var(--ww-space-3)', width: '100%' }}>退出并清除草稿</Button></aside>
      </div>
    </AppShell>
  );
}
