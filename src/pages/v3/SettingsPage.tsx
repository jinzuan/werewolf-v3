import { ArrowLeft, Home, Monitor, Save, UserRound, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/shell/AppShell';
import { endpointDiagnosticsEnabled, getServerUrl, setServerUrl } from '../../net/serverEndpoint';
import { useV3Store } from '../../stores/v3Store';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Input } from '../../ui/Input';
import { DragSegmented } from '../../ui/DragSegmented';
import {
  PLAYER_AVATAR_IDS,
  PLAYER_BIO_MAX_LENGTH,
  PLAYER_NICKNAME_MAX_LENGTH,
  readPlayerAvatarId,
  readPlayerBio,
  readPlayerNickname,
  writePlayerProfile,
} from '../../runtime/playerProfile';
import { avatarAssetMap } from '../../ui/assetRegistry';
import {
  BACKGROUND_MODES,
  BACKGROUND_PRESETS,
  COLOR_SCHEMES,
  GLASS_TINT_SCOPES,
  GLASS_TINT_SOURCES,
  MOTION_MODES,
  VISUAL_MODES,
  loadVisualPreferences,
  announceVisualPreferencesChanged,
  resetVisualPreferences,
  saveVisualPreferences,
  normalizeVisualPreferences,
  deepenGlassTintColor,
  type BackgroundMode,
  type BackgroundPreset,
  type ColorScheme,
  type GlassTintScope,
  type GlassTintSource,
  type MotionMode,
  type VisualMode,
} from '../../runtime/visualPreferences';
import {
  visualBackgroundStore,
  type VisualBackgroundMetadata,
  type VisualBackgroundSlot,
  type VisualBackgroundValidationCode,
} from '../../runtime/visualBackgroundStore';

const validationMessage: Record<Exclude<VisualBackgroundValidationCode, 'ok'>, string> = {
  empty: '图片文件为空。',
  'too-large': '单张图片不能超过 12 MiB。',
  'unsupported-type': '仅支持 PNG、JPEG、WebP 或 AVIF。',
  'decode-failed': '浏览器无法读取这张图片，请换一张。',
  'decode-unavailable': '当前浏览器不支持自定义背景解码。',
};

const visualModeLabels: Record<VisualMode, string> = {
  original: '原版',
  frosted: '毛玻璃',
  'low-transparency': '低透玻璃',
  transparent: '透明玻璃',
};

const backgroundModeLabels: Record<BackgroundMode, string> = {
  builtin: '内置昼夜',
  single: '自定义单图',
  dual: '自定义昼夜',
};

const backgroundPresetLabels: Record<BackgroundPreset, string> = {
  oriental: '东方幻想',
  cinematic: '电影概念',
  dream: '梦境月影',
};

const tintScopeLabels: Record<GlassTintScope, string> = {
  none: '无染色',
  day: '白天增强',
  night: '夜晚染色',
  always: '全天染色',
};

const tintSourceLabels: Record<GlassTintSource, string> = {
  auto: '背景取色',
  custom: '自选颜色',
};

const colorSchemeLabels: Record<ColorScheme, string> = {
  system: '跟随系统',
  light: '亮色',
  dark: '暗色',
};

const motionModeLabels: Record<MotionMode, string> = {
  none: '无动效',
  standard: '标准动效',
  full: '完整动效',
};

export function SettingsPage() {
  const navigate = useNavigate();
  const connected = useV3Store((state) => state.connected);
  const [preferences] = useState(() => loadVisualPreferences());
  const [backgrounds, setBackgrounds] = useState<VisualBackgroundMetadata[]>([]);
  const [loadingBackgrounds, setLoadingBackgrounds] = useState(true);
  const [visualMode, setVisualMode] = useState<VisualMode>(preferences.visualMode);
  const [backgroundMode, setBackgroundMode] = useState<BackgroundMode>(preferences.backgroundMode);
  const [backgroundPreset, setBackgroundPreset] = useState<BackgroundPreset>(preferences.backgroundPreset);
  const [motionPreference, setMotionPreference] = useState<MotionMode>(preferences.motionMode);
  const [colorScheme, setColorScheme] = useState<ColorScheme>(preferences.colorScheme);
  const [tintScope, setTintScope] = useState<GlassTintScope>(preferences.tintScope);
  const [tintSource, setTintSource] = useState<GlassTintSource>(preferences.tintSource);
  const [tintIntensity, setTintIntensity] = useState(preferences.tintIntensity);
  const [tintColor, setTintColor] = useState(preferences.tintColor);
  const [backgroundFiles, setBackgroundFiles] = useState<Partial<Record<VisualBackgroundSlot, File>>>({});
  const [visualError, setVisualError] = useState('');
  const [nickname, setNickname] = useState(() => readPlayerNickname());
  const [bio, setBio] = useState(() => readPlayerBio());
  const [avatarId, setAvatarId] = useState(() => readPlayerAvatarId());
  const diagnosticsEnabled = endpointDiagnosticsEnabled();
  const [serverUrl, updateServerUrl] = useState(() => getServerUrl());
  const [saved, setSaved] = useState(false);
  const [visualBusy, setVisualBusy] = useState(false);
  const visualOperationInFlight = useRef(false);
  const visualPreferencesRef = useRef(preferences);
  const tintCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void visualBackgroundStore.metadata().then((metadata) => {
      if (cancelled) return;
      setBackgrounds(metadata);
      setLoadingBackgrounds(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => {
    if (tintCommitTimer.current) {
      clearTimeout(tintCommitTimer.current);
      saveVisualPreferences(visualPreferencesRef.current);
    }
  }, []);

  const announceVisualChange = () => {
    announceVisualPreferencesChanged();
  };

  const syncVisualPreferencesToPage = (savedPreferences: typeof preferences) => {
    visualPreferencesRef.current = savedPreferences;
    setVisualMode(savedPreferences.visualMode);
    setBackgroundMode(savedPreferences.backgroundMode);
    setBackgroundPreset(savedPreferences.backgroundPreset);
    setMotionPreference(savedPreferences.motionMode);
    setColorScheme(savedPreferences.colorScheme);
    setTintScope(savedPreferences.tintScope);
    setTintSource(savedPreferences.tintSource);
    setTintIntensity(savedPreferences.tintIntensity);
    setTintColor(savedPreferences.tintColor);
    document.documentElement.dataset.visualMode = savedPreferences.visualMode;
    document.documentElement.dataset.backgroundMode = savedPreferences.backgroundMode;
    document.documentElement.dataset.backgroundPreset = savedPreferences.backgroundPreset;
    document.documentElement.dataset.motion = savedPreferences.motionMode;
    document.documentElement.dataset.colorScheme = savedPreferences.colorScheme;
    document.documentElement.dataset.glassTintScope = savedPreferences.tintScope;
    document.documentElement.dataset.glassTintSource = savedPreferences.tintSource;
    document.documentElement.style.setProperty('--ww-glass-tint-intensity', String(savedPreferences.tintIntensity));
    if (savedPreferences.tintSource === 'custom') {
      document.documentElement.style.setProperty('--ww-glass-tint-day', deepenGlassTintColor(savedPreferences.tintColor));
      document.documentElement.style.setProperty('--ww-glass-tint-night', savedPreferences.tintColor);
    }
  };

  const applyVisualPreferences = (next: Partial<typeof preferences>) => {
    if (tintCommitTimer.current) {
      clearTimeout(tintCommitTimer.current);
      tintCommitTimer.current = null;
    }
    const savedPreferences = saveVisualPreferences({
      ...visualPreferencesRef.current,
      ...next,
      schemaVersion: preferences.schemaVersion,
    });
    syncVisualPreferencesToPage(savedPreferences);
    announceVisualChange();
  };

  const previewTintPreferences = (next: Partial<typeof preferences>) => {
    const preview = normalizeVisualPreferences({
      ...visualPreferencesRef.current,
      ...next,
      schemaVersion: preferences.schemaVersion,
    });
    syncVisualPreferencesToPage(preview);
    if (tintCommitTimer.current) clearTimeout(tintCommitTimer.current);
    tintCommitTimer.current = setTimeout(() => {
      tintCommitTimer.current = null;
      saveVisualPreferences(visualPreferencesRef.current);
      announceVisualChange();
    }, 140);
  };

  const beginVisualOperation = (): boolean => {
    if (visualOperationInFlight.current) return false;
    visualOperationInFlight.current = true;
    setVisualBusy(true);
    return true;
  };

  const endVisualOperation = () => {
    visualOperationInFlight.current = false;
    setVisualBusy(false);
  };

  const save = async () => {
    if (!beginVisualOperation()) return;
    if (tintCommitTimer.current) {
      clearTimeout(tintCommitTimer.current);
      tintCommitTimer.current = null;
    }
    setVisualError('');
    // Keep the pre-existing profile and diagnostics save path independent of
    // optional image decoding/IndexedDB failures.
    const profile = writePlayerProfile({ nickname, bio, avatarId });
    setNickname(profile.nickname);
    setBio(profile.bio);
    setAvatarId(profile.avatarId);
    if (diagnosticsEnabled) setServerUrl(serverUrl.trim());
    try {
      const entries = Object.entries(backgroundFiles) as [VisualBackgroundSlot, File][];
      if (entries.length > 0) {
        const result = await visualBackgroundStore.putMany(entries.map(([slot, file]) => ({
          slot,
          blob: file,
          options: { fileName: file.name, lastModified: file.lastModified },
        })));
        if (result.ok === false) {
          setVisualError(result.code === 'storage-failed'
            ? '无法保存本机背景，请检查浏览器存储权限。'
            : validationMessage[result.code]);
          setSaved(false);
          return;
        }
        setBackgrounds(await visualBackgroundStore.metadata());
      }
      saveVisualPreferences(visualPreferencesRef.current);
      setBackgroundFiles({});
      announceVisualChange();
      setSaved(true);
    } finally {
      endVisualOperation();
    }
  };

  const chooseBackground = (slot: VisualBackgroundSlot) => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // The File object remains valid after clearing the native input, and the
    // same path can then be selected again after save or validation failure.
    event.currentTarget.value = '';
    if (!file) return;
    setBackgroundFiles((current) => ({ ...current, [slot]: file }));
    setVisualError('');
    setSaved(false);
  };

  const backgroundName = (slot: VisualBackgroundSlot): string =>
    backgroundFiles[slot]?.name
    ?? backgrounds.find((entry) => entry.slot === slot)?.fileName
    ?? '尚未选择，将使用内置背景';

  const clearBackground = async (slot: VisualBackgroundSlot) => {
    if (!beginVisualOperation()) return;
    try {
      const hasStoredBackground = backgrounds.some((entry) => entry.slot === slot);
      if (hasStoredBackground && !await visualBackgroundStore.delete(slot)) {
        setVisualError('无法清除本机背景，请检查浏览器存储权限。');
        return;
      }
      setBackgrounds(await visualBackgroundStore.metadata());
      setBackgroundFiles((current) => {
        const next = { ...current };
        delete next[slot];
        return next;
      });
      setVisualError('');
      setSaved(false);
      announceVisualChange();
    } finally {
      endVisualOperation();
    }
  };

  const resetVisuals = async () => {
    if (!beginVisualOperation()) return;
    try {
      const backgroundsCleared = backgrounds.length === 0
        || await visualBackgroundStore.clear();
      if (tintCommitTimer.current) {
        clearTimeout(tintCommitTimer.current);
        tintCommitTimer.current = null;
      }
      syncVisualPreferencesToPage(resetVisualPreferences());
      setBackgroundFiles({});
      setVisualError(backgroundsCleared
        ? ''
        : '已恢复原版，但无法删除之前保存在本机的背景。');
      setSaved(false);
      if (backgroundsCleared) setBackgrounds([]);
      announceVisualChange();
    } finally {
      endVisualOperation();
    }
  };

  return (
    <AppShell title="设置" eyebrow="玩家端偏好" connected={connected}>
      <div className="v3-page-heading">
        <div><span>本地显示与辅助功能</span><h1>设置</h1></div>
        <div className="v3-page-heading__actions">
          <Button variant="quiet" onClick={() => navigate(-1)}><ArrowLeft size={17} />返回上一级</Button>
          <Link className="v3-button v3-button--quiet" to="/lobby"><Home size={17} />返回大厅</Link>
          <Button disabled={visualBusy} onClick={() => void save()}><Save size={17} />{visualBusy ? '正在保存…' : saved ? '已保存' : '保存设置'}</Button>
        </div>
      </div>

      <div className="v3-settings-layout">
        <Card>
          <div className="v3-panel-heading">
            <div><span>局外个人资料</span><h2>我的资料</h2></div>
            <UserRound size={18} aria-hidden="true" />
          </div>
          <label className="v3-field">
            <span>显示名称</span>
            <Input
              disabled={visualBusy}
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
          <div className="v3-field">
            <span>头像</span>
            <DragSegmented
              className="v3-segmented"
              ariaLabel="头像选择"
              value={avatarId}
              disabled={visualBusy}
              data-motion={motionPreference}
              options={PLAYER_AVATAR_IDS.map((id) => {
                const kind = id === 'avatar-computer' ? 'computer' : id === 'avatar-spectator' ? 'spectator' : 'player';
                return {
                  value: id,
                  ariaLabel: avatarAssetMap[kind].label,
                  label: <img src={avatarAssetMap[kind].src} alt="" width="28" height="28" />,
                };
              })}
              onChange={(value) => { setAvatarId(value); setSaved(false); }}
            />
          </div>
          <label className="v3-field">
            <span>个人简介</span>
            <textarea disabled={visualBusy} className="v3-input" value={bio} maxLength={PLAYER_BIO_MAX_LENGTH} rows={3} placeholder="写一句让别人认识你的话（可选）" onChange={(event) => { setBio(event.target.value); setSaved(false); }} />
            <span className="v3-field__hint">最多 {PLAYER_BIO_MAX_LENGTH} 字，仅保存在本机资料中。</span>
          </label>
        </Card>
        {diagnosticsEnabled ? (
          <Card>
            <div className="v3-panel-heading"><div><span>开发诊断</span><h2>服务连接</h2></div></div>
            <label className="v3-setting-row">
              <div><strong>服务端地址</strong><span>仅开发/测试诊断使用；保存后刷新页面以建立新连接。</span></div>
              <Input disabled={visualBusy} value={serverUrl} onChange={(event) => { updateServerUrl(event.target.value); setSaved(false); }} />
            </label>
          </Card>
        ) : null}
        <Card>
          <div className="v3-panel-heading"><div><span>云端服务</span><h2>服务端入口</h2></div><Monitor size={18} aria-hidden="true" /></div>
          <div className="v3-setting-row">
            <div><strong>服务端状态页</strong><span>打开后可查看云端服务是否在线。</span></div>
            <a className="v3-button v3-button--quiet" href={`${serverUrl.replace(/\/$/u, '')}/`} target="_blank" rel="noreferrer">打开服务端</a>
          </div>
        </Card>
        <Card>
          <div className="v3-panel-heading"><div><span>月光森林视觉</span><h2>显示</h2></div><Monitor size={18} aria-hidden="true" /></div>
          <div className="v3-setting-row">
            <div><strong>界面材质</strong><span>原版保持当前界面；其它模式只改变材质和背景，不改变布局与功能。</span></div>
            <DragSegmented className="v3-segmented" ariaLabel="界面材质" value={visualMode} disabled={visualBusy} data-motion={motionPreference} options={VISUAL_MODES.map((value) => ({ value, label: visualModeLabels[value] }))} onChange={(value) => { applyVisualPreferences({ visualMode: value }); setSaved(false); }} />
          </div>
          <div className="v3-setting-row">
            <div><strong>大厅明暗</strong><span>局外页面可跟随系统或固定亮暗；进入对局后由游戏阶段切换。自定义单图始终保持同一背景。</span></div>
            <DragSegmented className="v3-segmented" ariaLabel="大厅明暗" value={colorScheme} disabled={visualBusy} data-motion={motionPreference} options={COLOR_SCHEMES.map((value) => ({ value, label: colorSchemeLabels[value] }))} onChange={(value) => { applyVisualPreferences({ colorScheme: value }); setSaved(false); }} />
          </div>
          <div className="v3-setting-row">
            <div><strong>背景来源</strong><span>自定义图片仅保存在本机；单图昼夜共用，双图按游戏阶段自动切换。</span></div>
            <DragSegmented className="v3-segmented" ariaLabel="背景来源" value={backgroundMode} disabled={visualBusy} data-motion={motionPreference} options={BACKGROUND_MODES.map((value) => ({ value, label: backgroundModeLabels[value] }))} onChange={(value) => { applyVisualPreferences({ backgroundMode: value }); setSaved(false); }} />
          </div>
          {backgroundMode === 'builtin' ? (
            <div className="v3-setting-row">
              <div><strong>场景预设</strong><span>每套预设都包含独立的白天与夜晚背景。</span></div>
              <DragSegmented className="v3-segmented" ariaLabel="场景预设" value={backgroundPreset} disabled={visualBusy} data-motion={motionPreference} options={BACKGROUND_PRESETS.map((value) => ({ value, label: backgroundPresetLabels[value] }))} onChange={(value) => { applyVisualPreferences({ backgroundPreset: value }); setSaved(false); }} />
            </div>
          ) : null}
          {backgroundMode === 'single' ? (
            <div className="v3-setting-row v3-setting-row--background-upload">
              <div><strong>自定义背景</strong><span>{backgroundName('single')}</span></div>
              <div className="v3-background-upload-actions">
                <label className="v3-button v3-button--secondary">选择图片<input disabled={visualBusy} type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={chooseBackground('single')} /></label>
                <Button variant="quiet" disabled={visualBusy} onClick={() => void clearBackground('single')}>清除</Button>
              </div>
            </div>
          ) : null}
          {backgroundMode === 'dual' ? (['day', 'night'] as const).map((slot) => (
            <div key={slot} className="v3-setting-row v3-setting-row--background-upload">
              <div><strong>{slot === 'day' ? '白天背景' : '夜晚背景'}</strong><span>{backgroundName(slot)}</span></div>
              <div className="v3-background-upload-actions">
                <label className="v3-button v3-button--secondary">选择图片<input disabled={visualBusy} type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={chooseBackground(slot)} /></label>
                <Button variant="quiet" disabled={visualBusy} onClick={() => void clearBackground(slot)}>清除</Button>
              </div>
            </div>
          )) : null}
          {visualError ? <div className="v3-alert v3-alert--error" role="alert">{visualError}</div> : null}
          {loadingBackgrounds ? <span className="v3-field__hint">正在载入本机背景……</span> : null}
          <div className="v3-setting-row">
            <div><strong>动态偏好</strong><span>无动效只保留基础操作；标准动效提供 Q 弹拖拽；完整动效会根据指针位置产生压力、拉伸、惯性和折射反馈。</span></div>
            <DragSegmented className="v3-segmented" ariaLabel="动态偏好" value={motionPreference} disabled={visualBusy} data-motion={motionPreference} options={MOTION_MODES.map((value) => ({ value, label: motionModeLabels[value] }))} onChange={(value) => { applyVisualPreferences({ motionMode: value }); setSaved(false); }} />
          </div>
          <div className="v3-setting-row">
            <div><strong>玻璃染色时段</strong><span>白天增强会从当前日景中提取最深的主色，提升亮背景上的文字和控件辨识度。</span></div>
            <DragSegmented className="v3-segmented" ariaLabel="玻璃染色时段" value={tintScope} disabled={visualBusy} data-motion={motionPreference} options={GLASS_TINT_SCOPES.map((value) => ({ value, label: tintScopeLabels[value] }))} onChange={(value) => { applyVisualPreferences({ tintScope: value }); setSaved(false); }} />
          </div>
          {tintScope !== 'none' ? (
            <>
              <div className="v3-setting-row">
                <div><strong>染色颜色</strong><span>背景取色完全在本机完成；自选颜色会用于所选时段。</span></div>
                <DragSegmented className="v3-segmented" ariaLabel="染色颜色来源" value={tintSource} disabled={visualBusy} data-motion={motionPreference} options={GLASS_TINT_SOURCES.map((value) => ({ value, label: tintSourceLabels[value] }))} onChange={(value) => { applyVisualPreferences({ tintSource: value }); setSaved(false); }} />
              </div>
              <div className="v3-setting-row v3-setting-row--tint-strength">
                <div><strong>染色强度</strong><span>只改变玻璃表面，不改变背景图片和文字颜色。</span></div>
                <label className="v3-tint-strength">
                  <input disabled={visualBusy} type="range" min="0" max="100" step="1" value={tintIntensity} onChange={(event) => { previewTintPreferences({ tintIntensity: Number(event.target.value) }); setSaved(false); }} />
                  <output>{tintIntensity}%</output>
                </label>
              </div>
              {tintSource === 'custom' ? (
                <div className="v3-setting-row">
                  <div><strong>自选染色</strong><span>选择带有明确色相的深色效果最好。</span></div>
                  <label className="v3-tint-color">
                    <input disabled={visualBusy} type="color" value={tintColor} onChange={(event) => { previewTintPreferences({ tintColor: event.target.value }); setSaved(false); }} />
                    <span>{tintColor}</span>
                  </label>
                </div>
              ) : null}
            </>
          ) : null}
          <div className="v3-setting-row">
            <div><strong>恢复默认视觉</strong><span>清除本机背景并恢复推荐的透明玻璃、标准动效与梦境月影，不影响玩家资料和房间数据。</span></div>
            <Button variant="quiet" disabled={visualBusy} onClick={() => void resetVisuals()}>恢复默认</Button>
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
