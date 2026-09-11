import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import {
  disposeSessionPersistence,
  startSessionPersistence,
} from './runtime/sessionPersistence'
import './styles/v3.css'
import './styles/liquid-glass.css'
import { V3Runtime } from './runtime/v3Runtime'

startSessionPersistence()

const root = createRoot(document.getElementById('root')!)
const runtime = new V3Runtime();
runtime.start();
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
)

let disposeVisualEffects = () => {};
let visualEffectsDisposed = false;
let visualEffectsStarted = false;
let visualEffectsIdleHandle = 0;
let visualEffectsTimer = 0;
const visualPreferencesChangeEvent = 'werewolf-v3-visual-preferences-change';
const idleWindow = window as Window & typeof globalThis & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};
const startVisualEffectsWhenNeeded = () => {
  if (visualEffectsDisposed || visualEffectsStarted) return;
  visualEffectsStarted = true;
  void import('./runtime/visualEffectsRuntime')
    .then(({ startVisualEffects }) => {
      if (visualEffectsDisposed) return;
      disposeVisualEffects = startVisualEffects();
    })
    .catch(() => { visualEffectsStarted = false; });
};
const cancelScheduledVisualEffects = () => {
  if (visualEffectsIdleHandle) idleWindow.cancelIdleCallback?.(visualEffectsIdleHandle);
  if (visualEffectsTimer) window.clearTimeout(visualEffectsTimer);
  visualEffectsIdleHandle = 0;
  visualEffectsTimer = 0;
};
const scheduleVisualEffectsWhenNeeded = () => {
  if (visualEffectsDisposed || visualEffectsStarted) return;
  if (idleWindow.requestIdleCallback) {
    visualEffectsIdleHandle = idleWindow.requestIdleCallback(() => {
      visualEffectsIdleHandle = 0;
      startVisualEffectsWhenNeeded();
    }, { timeout: 450 });
    return;
  }
  visualEffectsTimer = window.setTimeout(() => {
    visualEffectsTimer = 0;
    startVisualEffectsWhenNeeded();
  }, 0);
};
const onVisualPreferencesChange = () => {
  cancelScheduledVisualEffects();
  startVisualEffectsWhenNeeded();
};
// Default/original mode avoids loading the visual runtime until the player
// actually selects a glass mode. Route rendering and lazy page imports always
// receive the first frame; optics start during the first idle window.
if (document.documentElement.dataset.visualMode !== 'original') scheduleVisualEffectsWhenNeeded();
window.addEventListener(visualPreferencesChangeEvent, onVisualPreferencesChange);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    visualEffectsDisposed = true
    cancelScheduledVisualEffects()
    window.removeEventListener(visualPreferencesChangeEvent, onVisualPreferencesChange)
    disposeVisualEffects()
    disposeSessionPersistence()
    runtime.dispose()
    root.unmount()
  })
}
