import { resetV3Transport } from '../net/v3Socket';
import { useV3Store } from '../stores/v3Store';

export interface V3RuntimeOptions {
  start?: () => void | (() => void);
  dispose?: () => void;
}

/**
 * Owns the process-wide V3 browser lifecycle. React may mount its tree more
 * than once in development; the transport and recovery work must still have
 * exactly one owner.
 */
export class V3Runtime {
  private started = false;
  private subscriptionCleanup: (() => void) | null = null;

  constructor(private readonly options: V3RuntimeOptions = {}) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    const cleanup = this.options.start
      ? this.options.start()
      : useV3Store.getState().initialize();
    this.subscriptionCleanup = typeof cleanup === 'function' ? cleanup : null;
  }

  dispose(): void {
    if (!this.started) return;
    this.started = false;
    this.subscriptionCleanup?.();
    this.subscriptionCleanup = null;
    this.options.dispose?.();
    if (!this.options.dispose) resetV3Transport();
  }
}
