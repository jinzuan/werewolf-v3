import type { ProjectedSnapshot } from '../../shared/events';

/** A sample ties the server's clock to the browser clock at receipt time. */
export interface ServerClockSample {
  serverTime: number;
  receivedAt: number;
}

export const sampleServerClock = (
  snapshot: Pick<ProjectedSnapshot, 'serverTime'>,
  receivedAt = Date.now(),
): ServerClockSample | null =>
  typeof snapshot.serverTime === 'number'
    ? { serverTime: snapshot.serverTime, receivedAt }
    : null;

export const serverNow = (
  sample: ServerClockSample | null,
  now = Date.now(),
): number =>
  sample ? now + sample.serverTime - sample.receivedAt : now;

export const remainingServerMs = (
  deadlineTs: number | null | undefined,
  sample: ServerClockSample | null,
  now = Date.now(),
): number | null => {
  if (typeof deadlineTs !== 'number') return null;
  return Math.max(0, deadlineTs - serverNow(sample, now));
};

/**
 * Progress is meaningful only when both authoritative stage boundaries are
 * present.  Stage revision is a concurrency token, never a percentage.
 */
export const stageProgress = (
  stageStartedAt: number | null | undefined,
  deadlineTs: number | null | undefined,
  sample: ServerClockSample | null,
  now = Date.now(),
): number | null => {
  if (
    typeof stageStartedAt !== 'number' ||
    typeof deadlineTs !== 'number' ||
    deadlineTs <= stageStartedAt
  ) {
    return null;
  }
  return Math.min(
    100,
    Math.max(
      0,
      ((serverNow(sample, now) - stageStartedAt) /
        (deadlineTs - stageStartedAt)) *
        100,
    ),
  );
};
