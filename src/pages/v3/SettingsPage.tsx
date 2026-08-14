import { Accessibility, Bell, Monitor, Save, Volume2 } from 'lucide-react';
import { useState } from 'react';
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

export function SettingsPage() {
  const connected = useV3Store((state) => state.connected);
  const [motion, setMotion] = useState(true);
  const [captions, setCaptions] = useState(true);
  const [notifications, setNotifications] = useState(false);
  const [serverUrl, updateServerUrl] = useState(getServerUrl());
  const [saved, setSaved] = useState(false);

  const save = () => {
    setServerUrl(serverUrl.trim());
    localStorage.setItem('werewolf-v3-motion', String(motion));
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
      <div className="v3-settings-tabs">
        <button className="is-active"><Monitor size={17} />显示</button>
        <button><Volume2 size={17} />声音</button>
        <button><Accessibility size={17} />辅助功能</button>
      </div>

      <div className="v3-settings-layout">
        <Card>
          <div className="v3-panel-heading"><div><span>V3 socket.io</span><h2>服务连接</h2></div></div>
          <label className="v3-setting-row">
            <div><strong>服务端地址</strong><span>保存后刷新页面以建立新连接。</span></div>
            <Input value={serverUrl} onChange={(event) => updateServerUrl(event.target.value)} />
          </label>
        </Card>
        <Card>
          <div className="v3-panel-heading"><div><span>主题与动态</span><h2>显示</h2></div></div>
          <div className="v3-setting-row">
            <div><strong>主题</strong><span>正式产品使用固定深紫金暗色主题。</span></div>
            <span className="v3-static-value">深紫金</span>
          </div>
          <div className="v3-setting-row">
            <div><strong>界面动效</strong><span>阶段切换与新事件使用短时过渡。</span></div>
            <Toggle checked={motion} onChange={() => setMotion((value) => !value)} label="界面动效" />
          </div>
          <div className="v3-setting-row">
            <div><strong>减少动态</strong><span>覆盖系统偏好时立即移除位移和脉冲。</span></div>
            <div className="v3-segmented">
              <button className="is-active">跟随系统</button><button>开</button><button>关</button>
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
          <Bell size={19} />
          <div><strong>服务端 AI 参数不在玩家端展示</strong><span>API Key、模型、温度和超时由服务端配置管理。</span></div>
        </Card>
      </div>
    </AppShell>
  );
}
