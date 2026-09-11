import type { CommandReceipt, ProtocolAckError } from '../../shared/protocol';

export type CommandOutcomeStatus =
  | 'committed'
  | 'rejected'
  | 'unknown'
  | 'not_sent';

export interface CommandOutcome {
  commandId: string;
  commandType: string;
  status: CommandOutcomeStatus;
  createdAt: number;
  receipt?: CommandReceipt;
  errorCode?: ProtocolAckError['code'];
}

/** Small deterministic registry shared by UI actions and reconnect handling. */
export class CommandOutcomeRegistry {
  private readonly outcomes = new Map<string, CommandOutcome>();

  begin(commandId: string, commandType: string, createdAt = Date.now()): CommandOutcome {
    const current = this.outcomes.get(commandId);
    if (current) return { ...current };
    const next: CommandOutcome = {
      commandId,
      commandType,
      status: 'unknown',
      createdAt,
    };
    this.outcomes.set(commandId, next);
    return { ...next };
  }

  markNotSent(commandId: string, commandType?: string): CommandOutcome {
    return this.set(commandId, 'not_sent', commandType);
  }

  markUnknown(commandId: string, commandType?: string): CommandOutcome {
    const current = this.outcomes.get(commandId);
    if (current?.status === 'committed' || current?.status === 'rejected') return { ...current };
    return this.set(commandId, 'unknown', commandType);
  }

  markCommitted(commandId: string, receipt?: CommandReceipt): CommandOutcome {
    const current = this.outcomes.get(commandId);
    const next: CommandOutcome = {
      ...(current ?? { commandId, commandType: receipt?.commandType ?? 'unknown', createdAt: Date.now() }),
      status: 'committed',
      ...(receipt ? { receipt } : {}),
      errorCode: undefined,
    };
    this.outcomes.set(commandId, next);
    return { ...next };
  }

  markRejected(
    commandId: string,
    errorCode?: ProtocolAckError['code'],
    receipt?: CommandReceipt,
  ): CommandOutcome {
    const current = this.outcomes.get(commandId);
    const next: CommandOutcome = {
      ...(current ?? { commandId, commandType: receipt?.commandType ?? 'unknown', createdAt: Date.now() }),
      status: 'rejected',
      ...(errorCode ? { errorCode } : {}),
      ...(receipt ? { receipt } : {}),
    };
    this.outcomes.set(commandId, next);
    return { ...next };
  }

  get(commandId: string): CommandOutcome | undefined {
    const outcome = this.outcomes.get(commandId);
    return outcome ? { ...outcome } : undefined;
  }

  all(): Record<string, CommandOutcome> {
    return Object.fromEntries(
      [...this.outcomes.entries()].map(([id, outcome]) => [id, { ...outcome }]),
    );
  }

  clear(commandId: string): void {
    this.outcomes.delete(commandId);
  }

  private set(
    commandId: string,
    status: CommandOutcomeStatus,
    commandType?: string,
  ): CommandOutcome {
    const current = this.outcomes.get(commandId);
    const next: CommandOutcome = {
      ...(current ?? {
        commandId,
        commandType: commandType ?? 'unknown',
        createdAt: Date.now(),
      }),
      ...(commandType ? { commandType } : {}),
      status,
    };
    this.outcomes.set(commandId, next);
    return { ...next };
  }
}
