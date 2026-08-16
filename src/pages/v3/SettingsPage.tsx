import { Monitor, Save, Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AppShell } from '../../components/shell/AppShell';
import { getServerUrl, setServerUrl } from '../../net/socket';
import { useV3Store } from '../../stores/v3Store';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Input } from '../../ui/Input';

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      className={`v3-toggle ${checked ? 'is-on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
    >
      <span />
    </button>
  );
}

type MotionPreference = 'system' | 'reduced' | 'full';

const readMotionPreference = (): MotionPreference => {
  if (typeof localStorage === 'undefined') return 'system';
  const value = localStorage.getItem('werewolf-v3-motion-mode');
  return value === 'reduced' || value === 'full' ? value : 'system';
};

export function SettingsPage() {
  const connected = useV3Store((state) => state.connected);
  const [motionPreference, setMotionPreference] = useState<MotionPreference>(readMotionPreference);
  const [captions, setCaptions] = useState(true);
  const [notifications, setNotifications] = useState(false);
  const [serverUrl, updateServerUrl] = useState(getServerUrl());
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.motion = motionPreference;
  }, [motionPreference]);

  const save = () => {
    setServerUrl(serverUrl.trim());
    localStorage.setItem('werewolf-v3-motion-mode', motionPreference);
    localStorage.setItem('werewolf-v3-captions', String(captions));
    localStorage.setItem('werewolf-v3-notifications', String(notifications));
    setSaved(true);
  };

  return (
    <AppShell title="设置" eyebrow="玩家端偏好" connected={connected}>
      <div className="v3-page-heading">
        <div><span>本地显示与辅助功能</span><h1>设置</h1></div>
        <Button onClick={save}><Save size={17} />{saved ? '已保存' : '保存设置'}</Button>
      </div>

      <div className="v3-settings-layout">
        <Card>
          <div className="v3-panel-heading"><div><span>实时服务连接</span><h2>服务连接</h2></div></div>
          <label className="v3-setting-row">
            <div><strong>服务端地址</strong><span>保存后刷新页面以建立新连接。</span></div>
            <Input value={serverUrl} onChange={(event) => updateServerUrl(event.target.value)} />
          </label>
        </Card>
        <Card>
          <div className="v3-panel-heading"><div><span>月光森林视觉</span><h2>显示</h2></div><Monitor size={18} aria-hidden="true" /></div>
          <div className="v3-setting-row">
            <div><strong>场景</strong><span>日暮村庄、月下森林与篝火广场会跟随对局阶段切换。</span></div>
            <span className="v3-static-value">月光森林</span>
          </div>
          <div className="v3-setting-row">
            <div><strong>动态偏好</strong><span>“减少动态”会移除位移、脉冲和场景滑动，只保留必要状态变化。</span></div>
            <div className="v3-segmented" role="group" aria-label="动态偏好">
              {([['system', '跟随系统'], ['reduced', '减少动态'], ['full', '完整动态']] as const).map(([value, label]) => (
                <button key={value} type="button" className={motionPreference === value ? 'is-active' : undefined} aria-pressed={motionPreference === value} onClick={() => setMotionPreference(value)}>{label}</button>
              ))}
            </div>
          </div>
        </Card>

        <Card>
          <div className="v3-panel-heading"><div><span>提示强度</span><h2>声音与通知</h2></div></div>
          <label className="v3-setting-row">
            <div><strong>主音量</strong><span>语音、提示音和阶段音效。</span></div>
            <input type="range" min="0" max="100" defaultValue="64" aria-label="主音量" />
          </label>
          <div className="v3-setting-row">
            <div><strong>字幕与系统提示</strong><span>显示关键语音和阶段变化文字。</span></div>
            <Toggle checked={captions} onChange={() => setCaptions((value) => !value)} label="字幕与系统提示" />
          </div>
          <div className="v3-setting-row">
            <div><strong>桌面通知</strong><span>仅在轮到你行动时通知。</span></div>
            <Toggle checked={notifications} onChange={() => setNotifications((value) => !value)} label="桌面通知" />
          </div>
        </Card>

        <Card className="v3-settings-note">
          <Volume2 size={19} />
            <div><strong>电脑玩家参数由服务端管理</strong><span>玩家端只保留本地显示与辅助功能。进入等待房后，受权房主可在电脑玩家设置中管理模型服务；其他成员只能看到准备状态。</span></div>
        </Card>
      </div>
    </AppShell>
  );
}
