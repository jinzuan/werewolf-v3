import { ArrowLeft, Home, Monitor, Save, UserRound, Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/shell/AppShell';
import { endpointDiagnosticsEnabled, getServerUrl, setServerUrl } from '../../net/serverEndpoint';
import { useV3Store } from '../../stores/v3Store';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Input } from '../../ui/Input';
import {
  PLAYER_NICKNAME_MAX_LENGTH,
  readPlayerNickname,
  writePlayerNickname,
} from '../../runtime/playerProfile';

type MotionPreference = 'system' | 'reduced' | 'full';

const readMotionPreference = (): MotionPreference => {
  if (typeof localStorage === 'undefined') return 'system';
  const value = localStorage.getItem('werewolf-v3-motion-mode');
  return value === 'reduced' || value === 'full' ? value : 'system';
};

export function SettingsPage() {
  const navigate = useNavigate();
  const connected = useV3Store((state) => state.connected);
  const [motionPreference, setMotionPreference] = useState<MotionPreference>(readMotionPreference);
  const [nickname, setNickname] = useState(() => readPlayerNickname());
  const diagnosticsEnabled = endpointDiagnosticsEnabled();
  const [serverUrl, updateServerUrl] = useState(() => getServerUrl());
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.motion = motionPreference;
  }, [motionPreference]);

  const save = () => {
    localStorage.setItem('werewolf-v3-motion-mode', motionPreference);
    setNickname(writePlayerNickname(nickname));
    if (diagnosticsEnabled) setServerUrl(serverUrl.trim());
    setSaved(true);
  };

  return (
    <AppShell title="设置" eyebrow="玩家端偏好" connected={connected}>
      <div className="v3-page-heading">
        <div><span>本地显示与辅助功能</span><h1>设置</h1></div>
        <div className="v3-page-heading__actions">
          <Button variant="quiet" onClick={() => navigate(-1)}><ArrowLeft size={17} />返回上一级</Button>
          <Link className="v3-button v3-button--quiet" to="/lobby"><Home size={17} />返回大厅</Link>
          <Button onClick={save}><Save size={17} />{saved ? '已保存' : '保存设置'}</Button>
        </div>
      </div>

      <div className="v3-settings-layout">
        <Card>
          <div className="v3-panel-heading">
            <div><span>局外个人资料</span><h2>我的昵称</h2></div>
            <UserRound size={18} aria-hidden="true" />
          </div>
          <label className="v3-field">
            <span>显示名称</span>
            <Input
              value={nickname}
              maxLength={PLAYER_NICKNAME_MAX_LENGTH}
              autoComplete="nickname"
              onChange={(event) => {
                setNickname(event.target.value);
                setSaved(false);
              }}
            />
            <span className="v3-field__hint">保存后会用于大厅、开房和入座，不用每次重新填写。</span>
          </label>
        </Card>
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
          <Volume2 size={19} />
          <Monitor size={19} />
          <div><strong>电脑玩家参数由房主掌握，服务端管理</strong><span>创建房间会直接使用标准配置；进入等待房后，房主可从唯一的“房间设置”入口调整角色、AI 补位与高级参数，其他成员只看到摘要。</span></div>
        </Card>
      </div>
    </AppShell>
  );
}
