import { useEffect, useState } from 'react';
import type {
  RoomAIConfigPatch,
  RoomAIConfigSummary,
  RoomAIBehavior,
  RoomAIProvider,
  RoomViewV31,
} from '../../../../shared/roomContract';
import { AI_DEFAULTS } from '../../../../shared/config/aiDefaults';
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

const endpointFor = (provider: RoomAIProvider): string => {
  if (provider === 'siliconflow') return 'https://api.siliconflow.cn/v1/chat/completions';
  if (provider === 'deepseek') return 'https://api.deepseek.com/v1/chat/completions';
  return provider === 'local' ? 'http://127.0.0.1:1234/v1/chat/completions' : '';
};

interface RoomAIConfigEditorProps {
  room: RoomViewV31;
  open: boolean;
  pending: boolean;
  summary: RoomAIConfigSummary | null;
  status: 'idle' | 'loading' | 'ready' | 'updating' | 'error';
  error: string | null;
  onClose: () => void;
  onSubmit: (patch: RoomAIConfigPatch) => void;
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
}: RoomAIConfigEditorProps) {
  const [provider, setProvider] = useState<RoomAIProvider>('local');
  const [model, setModel] = useState(AI_DEFAULTS.local.model);
  const [endpoint, setEndpoint] = useState(endpointFor('local'));
  const [temperature, setTemperature] = useState(AI_DEFAULTS.local.temperature);
  const [maxTokens, setMaxTokens] = useState(AI_DEFAULTS.local.maxTokens);
  const [behavior, setBehavior] = useState<RoomAIBehavior>(AI_DEFAULTS.defaultBehavior);
  const [apiKey, setApiKey] = useState('');
  const [token, setToken] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [clearToken, setClearToken] = useState(false);

  useEffect(() => {
    if (!open) {
      setApiKey('');
      setToken('');
      setClearApiKey(false);
      setClearToken(false);
      return;
    }
    const nextProvider = summary?.provider ?? 'local';
    setProvider(nextProvider);
    setModel(summary?.model ?? (nextProvider === 'local' ? AI_DEFAULTS.local.model : AI_DEFAULTS[nextProvider === 'deepseek' ? 'deepseek' : 'siliconflow'].model));
    // The summary intentionally exposes only the origin. Leaving this blank
    // preserves a path configured previously; a new room gets a safe default.
    setEndpoint(summary ? '' : endpointFor(nextProvider));
    setTemperature(summary?.temperature ?? AI_DEFAULTS.local.temperature);
    setMaxTokens(summary?.maxTokens ?? AI_DEFAULTS.local.maxTokens);
    setBehavior(summary?.behavior ?? AI_DEFAULTS.defaultBehavior);
    setApiKey('');
    setToken('');
    setClearApiKey(false);
    setClearToken(false);
  }, [open, summary]);

  const submit = () => {
    const patch: RoomAIConfigPatch = {
      provider,
      model: model.trim(),
      temperature,
      maxTokens,
      behavior,
      ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(token.trim() ? { token: token.trim() } : {}),
      ...(clearApiKey ? { clearApiKey: true } : {}),
      ...(clearToken ? { clearToken: true } : {}),
    };
    // Secret inputs are cleared before the async command returns, including
    // validation failures. They never enter browser storage or the URL.
    setApiKey('');
    setToken('');
    onSubmit(patch);
  };

  const changeProvider = (next: RoomAIProvider) => {
    setProvider(next);
    setEndpoint(summary && next === summary.provider ? '' : endpointFor(next));
  };

  return (
    <Modal
      open={open}
      title="修改电脑玩家设置"
      context="密钥留空表示保持原值；只有勾选清除才会删除已保存凭据。"
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
            <span>接口地址</span>
            <Input
              value={endpoint}
              placeholder={summary ? '已保存；留空保持不变' : '请输入安全接口地址'}
              onChange={(event) => setEndpoint(event.target.value)}
              autoComplete="off"
            />
            {summary ? <small>当前接口来源：{summary.endpointOrigin}</small> : null}
          </label>
          <label className="waiting-room__editor-field">
            <span>温度（0–2）</span>
            <Input type="number" min={0} max={2} step={0.1} value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} />
          </label>
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

        <fieldset className="waiting-room__editor-secrets">
          <legend>凭据（仅本次编辑在内存中保留）</legend>
          <label className="waiting-room__editor-field">
            <span>API Key {summary?.hasApiKey ? '· 已保存' : '· 未设置'}</span>
            <Input
              type="password"
              value={apiKey}
              placeholder={summary?.hasApiKey ? '已保存；留空保持不变' : '留空表示不设置'}
              autoComplete="new-password"
              onChange={(event) => { setApiKey(event.target.value); setClearApiKey(false); }}
            />
          </label>
          <label className="waiting-room__editor-check">
            <input type="checkbox" checked={clearApiKey} onChange={(event) => { setClearApiKey(event.target.checked); if (event.target.checked) setApiKey(''); }} />
            <span>显式清除 API Key</span>
          </label>
          <label className="waiting-room__editor-field">
            <span>令牌 {summary?.hasToken ? '· 已保存' : '· 未设置'}</span>
            <Input
              type="password"
              value={token}
              placeholder={summary?.hasToken ? '已保存；留空保持不变' : '留空表示不设置'}
              autoComplete="new-password"
              onChange={(event) => { setToken(event.target.value); setClearToken(false); }}
            />
          </label>
          <label className="waiting-room__editor-check">
            <input type="checkbox" checked={clearToken} onChange={(event) => { setClearToken(event.target.checked); if (event.target.checked) setToken(''); }} />
            <span>显式清除令牌</span>
          </label>
        </fieldset>

        <p className="waiting-room__transition-note">保存后会清除真人准备状态，并回到等待确认。</p>
        {room.config.mode === 'human' ? <p className="waiting-room__empty-copy">纯真人房不需要电脑玩家配置。</p> : null}
      </div>
    </Modal>
  );
}
