import { ArrowRight, Monitor, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../../components/shell/AppShell';
import { endpointDiagnosticsEnabled, getServerUrl, setServerUrl } from '../../net/serverEndpoint';
import { useV3Store } from '../../stores/v3Store';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Input } from '../../ui/Input';

type MotionPreference = 'system' | 'reduced' | 'full';

const readMotionPreference = (): MotionPreference => {
  if (typeof localStorage === 'undefined') return 'system';
  const value = localStorage.getItem('werewolf-v3-motion-mode');
  return value === 'reduced' || value === 'full' ? value : 'system';
};

export function SettingsPage() {
  const connected = useV3Store((state) => state.connected);
  const [motionPreference, setMotionPreference] = useState<MotionPreference>(readMotionPreference);
  const diagnosticsEnabled = endpointDiagnosticsEnabled();
  const [serverUrl, updateServerUrl] = useState(() => getServerUrl());
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.motion = motionPreference;
  }, [motionPreference]);

  const save = () => {
    localStorage.setItem('werewolf-v3-motion-mode', motionPreference);
    if (diagnosticsEnabled) setServerUrl(serverUrl.trim());
    setSaved(true);
  };

  return (
    <AppShell title="设置" eyebrow="玩家端偏好" connected={connected}>
      <div className="v3-page-heading">
        <div><span>本地显示与辅助功能</span><h1>设置</h1></div>
        <Button onClick={save}><Save size={17} />{saved ? '已保存' : '保存设置'}</Button>
      </div>

      <div className="v3-settings-layout">
        {diagnosticsEnabled ? (
          <Card>
            <div className="v3-panel-heading"><div><span>开发诊断</span><h2>服务连接</h2></div></div>
            <label className="v3-setting-row">
              <div><strong>服务端地址</strong><span>仅开发/测试诊断使用；保存后刷新页面以建立新连接。</span></div>
              <Input value={serverUrl} onChange={(event) => updateServerUrl(event.target.value)} />
            </label>
          </Card>
        ) : null}
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

        <Card className="v3-settings-note">
          <Monitor size={19} />
          <div><strong>电脑玩家参数由房主掌握</strong><span>创建混合房或电脑局时，可以在开房向导填写模型、访问凭据和服务地址。</span></div>
          <Link className="v3-button v3-button--quiet" to="/rooms/new/players">打开开房向导<ArrowRight size={16} /></Link>
        </Card>
      </div>
    </AppShell>
  );
}
