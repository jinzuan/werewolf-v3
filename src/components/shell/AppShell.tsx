import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { RoomHeader } from '../../features/room-shell/RoomHeader';
import { useRoomShell } from '../../features/room-shell/RoomShellContext';
import { TopStatusBar } from './TopStatusBar';
import { SyncStatusNotice } from './SyncStatusNotice';
import {
  VISUAL_PREFERENCES_CHANGE_EVENT,
  VISUAL_PREFERENCES_STORAGE_KEY,
  loadVisualPreferences,
  resolveColorScheme,
} from '../../runtime/visualPreferences';

interface AppShellProps {
  children: ReactNode;
  title: string;
  eyebrow?: string;
  phase?: string;
  countdown?: string;
  live?: boolean;
  progress?: number;
  connected?: boolean;
  pageClassName?: string;
}

export function AppShell({ children, pageClassName, ...status }: AppShellProps) {
  const { inRoom, scene } = useRoomShell();
  const [visualPreferences, setVisualPreferences] = useState(() => loadVisualPreferences());
  const [systemPrefersDark, setSystemPrefersDark] = useState(() =>
    typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const media = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
    const refreshPreferences = () => setVisualPreferences(loadVisualPreferences());
    const refreshSystemScheme = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    const refreshFromStorage = (event: StorageEvent) => {
      if (!event.key || event.key === VISUAL_PREFERENCES_STORAGE_KEY) refreshPreferences();
    };
    media?.addEventListener('change', refreshSystemScheme);
    window.addEventListener(VISUAL_PREFERENCES_CHANGE_EVENT, refreshPreferences);
    window.addEventListener('storage', refreshFromStorage);
    return () => {
      media?.removeEventListener('change', refreshSystemScheme);
      window.removeEventListener(VISUAL_PREFERENCES_CHANGE_EVENT, refreshPreferences);
      window.removeEventListener('storage', refreshFromStorage);
    };
  }, []);

  const lobbyColorScheme = resolveColorScheme(visualPreferences.colorScheme, systemPrefersDark);
  const visualScene = useMemo(() => {
    if (!inRoom || visualPreferences.backgroundMode === 'single') {
      return lobbyColorScheme === 'dark' ? 'night' : 'day';
    }
    return scene;
  }, [inRoom, lobbyColorScheme, scene, visualPreferences.backgroundMode]);
  const visualTone = visualScene === 'night' || visualScene === 'dusk' ? 'dark' : 'light';

  useEffect(() => {
    document.documentElement.dataset.visualScene = visualScene;
    document.documentElement.dataset.resolvedColorScheme = visualTone;
    return () => {
      if (document.documentElement.dataset.visualScene === visualScene) {
        delete document.documentElement.dataset.visualScene;
      }
      if (document.documentElement.dataset.resolvedColorScheme === visualTone) {
        delete document.documentElement.dataset.resolvedColorScheme;
      }
    };
  }, [visualScene, visualTone]);

  return (
    <div
      className="v3-app-shell"
      data-scene={visualScene}
      data-room-scene={scene}
      data-visual-tone={visualTone}
    >
      <div className="v3-visual-backdrop" aria-hidden="true">
        <span className="v3-visual-backdrop__layer v3-visual-backdrop__layer--day" />
        <span className="v3-visual-backdrop__layer v3-visual-backdrop__layer--night" />
        <span className="v3-visual-backdrop__scrim" />
      </div>
      {inRoom ? (
        <RoomHeader {...status} scene={scene} />
      ) : (
        <TopStatusBar {...status} scene={visualScene} />
      )}
      <div className="v3-app-shell__body">
        <SyncStatusNotice />
        <main className={`v3-page ${pageClassName ?? ''}`.trim()}>{children}</main>
      </div>
    </div>
  );
}
