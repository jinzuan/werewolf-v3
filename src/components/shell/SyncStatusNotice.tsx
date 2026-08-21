import { useV3Store } from '../../stores/v3';

/** A compact reconnect notice that never replaces or covers the page action area. */
export function SyncStatusNotice() {
  const status = useV3Store((state) => state.syncStatus);
  const error = useV3Store((state) => state.syncError);
  const session = useV3Store((state) => state.session);
  const refreshSnapshot = useV3Store((state) => state.refreshSnapshot);

  if (!session || status === 'idle' || status === 'synced') return null;

  return (
    <div
      className={`v3-sync-status v3-sync-status--${status}`}
      role={status === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <span>
        {status === 'syncing'
          ? '正在恢复房间状态…'
          : error ?? '房间状态同步失败。'}
      </span>
      {status === 'error' ? (
        <button type="button" onClick={() => void refreshSnapshot()}>重试</button>
      ) : null}
    </div>
  );
}
