export function getServerOffset(serverTime: number | undefined, receivedAt = Date.now()): number {
  return typeof serverTime === 'number' ? serverTime - receivedAt : 0;
}

export function getRemainingMs(deadlineTs: number | null | undefined, serverOffset = 0, now = Date.now()): number | null {
  if (!deadlineTs) return null;
  return Math.max(0, deadlineTs - (now + serverOffset));
}

export function formatCountdown(ms: number | null): string {
  if (ms === null) return '—';
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
