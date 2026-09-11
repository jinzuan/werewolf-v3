export interface ReconnectLifecycleTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface ReconnectLifecycleOptions {
  documentTarget?: (ReconnectLifecycleTarget & { visibilityState?: string }) | null;
  windowTarget?: ReconnectLifecycleTarget | null;
}

const browserDocument = (): ReconnectLifecycleOptions['documentTarget'] =>
  typeof document === 'undefined' ? null : document;

const browserWindow = (): ReconnectLifecycleOptions['windowTarget'] =>
  typeof window === 'undefined' ? null : window;

/**
 * Mobile browsers can suspend Socket.IO timers while an app is backgrounded.
 * Re-entering the page is therefore an explicit recovery boundary in addition
 * to Socket.IO's own reconnect event. The callback is intentionally supplied
 * by the authority store so it remains single-flight and identity-aware.
 */
export const subscribeV3ReconnectLifecycle = (
  onReconnect: () => void,
  options: ReconnectLifecycleOptions = {},
): (() => void) => {
  const documentTarget = options.documentTarget === undefined
    ? browserDocument()
    : options.documentTarget;
  const windowTarget = options.windowTarget === undefined
    ? browserWindow()
    : options.windowTarget;
  const onVisibilityChange: EventListener = () => {
    if (documentTarget?.visibilityState === 'hidden') return;
    onReconnect();
  };
  const onPageShow: EventListener = () => onReconnect();
  const onOnline: EventListener = () => onReconnect();
  // iOS Safari and Android webviews do not all emit the same page lifecycle
  // event after an app switch. `focus` and the Page Lifecycle `resume` event
  // are cheap additional recovery boundaries for the same socket/session.
  const onFocus: EventListener = () => onReconnect();
  const onResume: EventListener = () => onReconnect();

  documentTarget?.addEventListener('visibilitychange', onVisibilityChange);
  windowTarget?.addEventListener('pageshow', onPageShow);
  windowTarget?.addEventListener('online', onOnline);
  windowTarget?.addEventListener('focus', onFocus);
  windowTarget?.addEventListener('resume', onResume);

  return () => {
    documentTarget?.removeEventListener('visibilitychange', onVisibilityChange);
    windowTarget?.removeEventListener('pageshow', onPageShow);
    windowTarget?.removeEventListener('online', onOnline);
    windowTarget?.removeEventListener('focus', onFocus);
    windowTarget?.removeEventListener('resume', onResume);
  };
};
