import { useEffect, useState } from 'react';
import type {
  RoomAIConfigPatch,
  RoomAIConfigSummary,
  RoomAIBehavior,
  RoomAIProvider,
  RoomViewV31,
} from '../../../../shared/roomContract';
import { ROOM_AI_DEFAULTS } from '../../../../shared/roomContract';
import { getAIProviderCapability } from '../../../../shared/aiProviderCapabilities';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Input';
import { Modal } from '../../../ui/Modal';

const PROVIDERS: Array<{ value: RoomAIProvider; label: string }> = [
  { value: 'siliconflow', label: 'SiliconFlow' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'local', label: '本地模型' },
  { value: 'custom', label: '自定义接口' },
];

const BEHAVIORS: Array<{ value: RoomAIBehavior; label: string }> = [
  { value: 'aggressive', label: '积极' },
  { value: 'conservative', label: '谨慎' },
  { value: 'random', label: '随机' },
];

const endpointFor = (provider: RoomAIProvider): string =>
  getAIProviderCapability(provider).defaultEndpoint;

const defaultsFor = (provider: RoomAIProvider) =>
  provider === 'custom' ? ROOM_AI_DEFAULTS.local : ROOM_AI_DEFAULTS[provider];

interface RoomAIConfigEditorProps {
  room: RoomViewV31;
  open: boolean;
  pending: boolean;
  summary: RoomAIConfigSummary | null;
  status: 'idle' | 'loading' | 'ready' | 'updating' | 'error';
  error: string | null;
  onClose: () => void;
  onSubmit: (patch: RoomAIConfigPatch) => void;
  targetAIName?: string | null;
}

export function RoomAIConfigEditor({
  room,
  open,
  pending,
  summary,
  status,
  error,
  onClose,
  onSubmit,
  targetAIName,
}: RoomAIConfigEditorProps) {
  const [provider, setProvider] = useState<RoomAIProvider>('local');
  const [model, setModel] = useState<string>(ROOM_AI_DEFAULTS.local.model);
  const [endpoint, setEndpoint] = useState(endpointFor('local'));
  const [temperature, setTemperature] = useState<number>(ROOM_AI_DEFAULTS.local.temperature);
  const [maxTokens, setMaxTokens] = useState<number>(ROOM_AI_DEFAULTS.local.maxTokens);
  const [behavior, setBehavior] = useState<RoomAIBehavior>(ROOM_AI_DEFAULTS.defaultBehavior);
  const [credential, setCredential] = useState('');
  const [clearCredential, setClearCredential] = useState(false);

  const applyDefaults = (nextProvider: RoomAIProvider = provider) => {
    const defaults = defaultsFor(nextProvider);
    setModel(defaults.model);
    setEndpoint(endpointFor(nextProvider));
    setTemperature(defaults.temperature);
    setMaxTokens(defaults.maxTokens);
    setBehavior(ROOM_AI_DEFAULTS.defaultBehavior);
  };

  useEffect(() => {
    if (!open) {
      setCredential('');
      setClearCredential(false);
      return;
    }
    const nextProvider = summary?.provider ?? 'local';
    setProvider(nextProvider);
    setModel(summary?.model ?? defaultsFor(nextProvider).model);
    // The summary intentionally exposes only the origin. Leaving this blank
    // preserves a path configured previously; a new room gets a safe default.
    setEndpoint(summary ? '' : endpointFor(nextProvider));
    setTemperature(summary?.temperature ?? defaultsFor(nextProvider).temperature);
    setMaxTokens(summary?.maxTokens ?? defaultsFor(nextProvider).maxTokens);
    setBehavior(summary?.behavior ?? ROOM_AI_DEFAULTS.defaultBehavior);
    setCredential('');
    setClearCredential(false);
  }, [open, summary]);

  const submit = () => {
    const capability = (summary?.provider === provider ? summary.capability : undefined) ??
      getAIProviderCapability(provider);
    const patch: RoomAIConfigPatch = {
      provider,
      model: model.trim(),
      temperature,
      maxTokens,
      behavior,
      ...(capability.endpointMode === 'configurable' && endpoint.trim()
        ? { endpoint: endpoint.trim() }
        : {}),
      ...(credential.trim() ? { credential: credential.trim() } : {}),
      ...(clearCredential ? { clearCredential: true } : {}),
    };
    // Secret inputs are cleared before the async command returns, including
    // validation failures. They never enter browser storage or the URL.
    setCredential('');
    onSubmit(patch);
  };

  const changeProvider = (next: RoomAIProvider) => {
    setProvider(next);
    applyDefaults(next);
  };

  const capability = (summary?.provider === provider ? summary.capability : undefined) ??
    getAIProviderCapability(provider);

  return (
    <Modal
      open={open}
      title={targetAIName ? `设置 AI · ${targetAIName}` : '修改电脑玩家设置'}
      context={targetAIName ? '当前为房主专属设置；模型与行动风格保存到本房间的电脑玩家服务。' : '凭据留空表示保持原值；只有勾选清除才会删除已保存凭据。'}
      onClose={onClose}
      size="wide"
      footer={(
        <>
          <Button variant="quiet" disabled={pending} onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={pending || status === 'loading'} onClick={submit}>
            {pending || status === 'updating' ? '正在保存…' : '保存电脑玩家设置'}
          </Button>
        </>
      )}
    >
      <div className="waiting-room__editor waiting-room__ai-editor">
        {error ? <div className="v3-alert v3-alert--error" role="alert">{error}</div> : null}
        {summary?.credentialRotationRequired ? (
          <div className="v3-alert v3-alert--warning" role="alert">
            旧版凭据已迁移但尚未轮换。请重新填写唯一 Bearer 凭据并保存；完成前不会向模型服务发起请求。
          </div>
        ) : null}
        {status === 'loading' ? <p className="waiting-room__empty-copy">正在读取房主可见设置…</p> : null}
        <div className="waiting-room__editor-grid">
          <label className="waiting-room__editor-field">
            <span>模型服务</span>
            <select value={provider} onChange={(event) => changeProvider(event.target.value as RoomAIProvider)}>
              {PROVIDERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className="waiting-room__editor-field">
            <span>模型名称</span>
            <Input value={model} onChange={(event) => setModel(event.target.value)} autoComplete="off" />
          </label>
          <label className="waiting-room__editor-field">
            <span>温度（0–2）</span>
            <Input type="number" min={0} max={2} step={0.1} value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} />
          </label>
        </div>

        <div className="waiting-room__ai-presets">
          <Button
            variant="quiet"
            disabled={pending || status === 'loading'}
            onClick={() => applyDefaults()}
          >
            一键填入推荐默认值
          </Button>
          <span>模型、接口、温度和行动风格会按当前服务自动填写；凭据不会自动填充。</span>
        </div>

        <details className="waiting-room__editor-advanced">
          <summary>高级参数：接口地址、输出长度、行动风格</summary>
          <div className="waiting-room__editor-grid">
            {capability.endpointMode === 'configurable' ? (
              <label className="waiting-room__editor-field">
                <span>接口地址</span>
                <Input
                  value={endpoint}
                  placeholder={summary ? '已保存；留空保持不变' : '请输入安全接口地址'}
                  onChange={(event) => setEndpoint(event.target.value)}
                  autoComplete="off"
                />
                {summary ? <small>当前接口来源：{summary.endpointOrigin}</small> : null}
              </label>
            ) : (
              <div className="waiting-room__editor-field">
                <span>接口地址</span>
                <p className="waiting-room__empty-copy">固定官方安全接口：{capability.defaultEndpoint}</p>
              </div>
            )}
            <label className="waiting-room__editor-field">
              <span>最大输出长度</span>
              <Input type="number" min={128} max={4096} step={1} value={maxTokens} onChange={(event) => setMaxTokens(Number.parseInt(event.target.value, 10))} />
            </label>
            <label className="waiting-room__editor-field">
              <span>行动风格</span>
              <select value={behavior} onChange={(event) => setBehavior(event.target.value as RoomAIBehavior)}>
                {BEHAVIORS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
          </div>
        </details>

        <fieldset className="waiting-room__editor-secrets">
          <legend>访问凭据（仅本次编辑在内存中保留）</legend>
          <label className="waiting-room__editor-field">
            <span>API 密钥 / Token {summary?.hasCredential ? '· 已保存' : '· 未设置'}</span>
            <Input
              type="password"
              value={credential}
              placeholder={summary?.hasCredential ? '已保存；留空保持不变' : '留空表示不设置'}
              autoComplete="new-password"
              onChange={(event) => { setCredential(event.target.value); setClearCredential(false); }}
            />
          </label>
          <label className="waiting-room__editor-check">
            <input type="checkbox" checked={clearCredential} onChange={(event) => { setClearCredential(event.target.checked); if (event.target.checked) setCredential(''); }} />
            <span>显式清除 Bearer 凭据</span>
          </label>
        </fieldset>

        <p className="waiting-room__transition-note">保存后会清除真人准备状态，并回到等待确认。</p>
        {room.config.mode === 'human' ? <p className="waiting-room__empty-copy">纯真人房不需要电脑玩家配置。</p> : null}
      </div>
    </Modal>
  );
}
