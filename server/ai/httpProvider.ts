import type { GameCommand } from '../../shared/protocol';
import type { AIConfig, GameAction } from '../../shared/types';
import { AI_TIMEOUT_MS } from '../../shared/config/aiDefaults';
import { loadAIConfig } from '../config';
import { EndpointPolicy } from '../security/endpointPolicy';
import { SafeHttpClient, type SafeHttpTransport } from '../security/safeHttpClient';
import { defaultAITelemetry, type AITelemetry } from './aiTelemetry';
import {
  AIQueueError,
  AICircuitBreaker,
  defaultAICircuitBreaker,
  defaultProviderQueue,
  ProviderQueue,
} from './providerQueue';
import type {
  AIProvider,
  AIProviderError,
  AIRequestContext,
  AISuggestion,
} from './types';
import { AIProviderError as ProviderError } from './types';

interface ProviderSettings {
  key: string;
  provider: 'siliconflow' | 'deepseek' | 'local';
  endpoint: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface HttpAIProviderOptions {
  fetch?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  endpointPolicy?: EndpointPolicy;
  /** Resolved by the room composition root; never silently replaced. */
  endpoint?: string;
  queue?: ProviderQueue;
  circuitBreaker?: AICircuitBreaker;
  enqueueTimeoutMs?: number;
  telemetry?: AITelemetry;
  safeHttpClient?: SafeHttpClient;
}

interface ResponseEnvelope {
  status: number;
  headers: Headers;
  data?: unknown;
}

const endpointFor = (config: AIConfig): string => {
  if (config.apiType === 'siliconflow') {
    return 'https://api.siliconflow.cn/v1/chat/completions';
  }
  if (config.apiType === 'deepseek') {
    return 'https://api.deepseek.com/v1/chat/completions';
  }
  return config.local.apiUrl;
};

const settingsFor = (config: AIConfig, endpointOverride?: string): ProviderSettings => {
  const endpoint = endpointOverride ?? endpointFor(config);
  const selected =
    config.apiType === 'siliconflow'
      ? config.siliconflow
      : config.apiType === 'deepseek'
        ? config.deepseek
        : config.local;
  return {
    key: `${config.apiType}:${endpoint}:${selected.model}`,
    provider: config.apiType,
    endpoint,
    apiKey: selected.apiKey,
    model: selected.model,
    temperature: selected.temperature,
    maxTokens: selected.maxTokens,
  };
};

const defaultSleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseRetryAfter = (
  value: string | null,
  now: () => number,
): number => {
  if (!value) return 0;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : Math.max(0, timestamp - now());
};

const actionForCommand = (
  command: GameCommand,
): GameAction | undefined => {
  switch (command.type) {
    case 'game.night_action':
      return command.payload.action === 'kill'
        ? undefined
        : command.payload.action;
    case 'game.wolf_speak':
      return 'wolf_speak';
    case 'game.wolf_vote':
      return 'wolf_vote';
    case 'game.skip_night':
      return 'skip_night';
    case 'game.speak':
      return 'speak';
    case 'game.skip_speech':
      return 'skip_speech';
    case 'game.vote':
      return command.payload.targetId === null ? 'abstain' : 'vote';
    case 'game.hunter_shoot':
      return command.payload.targetId === null
        ? 'skip_hunter_shot'
        : 'hunter_shoot';
  }
};

const validTarget = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

const validCommandPayload = (
  command: GameCommand,
  context: AIRequestContext,
): boolean => {
  if (!isRecord(command.payload)) return false;
  switch (command.type) {
    case 'game.speak':
    case 'game.wolf_speak':
      return typeof command.payload.content === 'string';
    case 'game.skip_speech':
      if (context.phase === 'lastWords' || context.stage === 'last_words') {
        return typeof command.payload.reason === 'string' && command.payload.reason.trim().length > 0;
      }
      return (
        command.payload.reason === undefined ||
        (typeof command.payload.reason === 'string' && command.payload.reason.trim().length > 0)
      );
    case 'game.vote':
    case 'game.wolf_vote':
    case 'game.hunter_shoot':
      return validTarget(command.payload.targetId);
    case 'game.night_action':
      return (
        command.payload.playerId === context.playerId &&
        ['kill', 'check', 'heal', 'poison', 'guard'].includes(
          command.payload.action,
        ) &&
        validTarget(command.payload.targetId)
      );
    case 'game.skip_night':
      return (
        typeof command.payload.action === 'string' &&
        ['guard', 'check', 'heal', 'poison'].includes(
          command.payload.action,
        )
      );
  }
};

const parseSuggestion = (
  data: unknown,
  context: AIRequestContext,
  retryCount: number,
): AISuggestion => {
  if (!isRecord(data)) {
    throw new ProviderError('invalid_response', retryCount);
  }
  const choices = data.choices;
  if (!Array.isArray(choices) || !isRecord(choices[0])) {
    throw new ProviderError('invalid_response', retryCount);
  }
  const message = choices[0].message;
  if (!isRecord(message) || typeof message.content !== 'string') {
    throw new ProviderError('invalid_response', retryCount);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(message.content);
  } catch {
    throw new ProviderError('invalid_output', retryCount);
  }
  if (!isRecord(parsed) || !isRecord(parsed.command)) {
    throw new ProviderError('invalid_output', retryCount);
  }
  const command = parsed.command as Partial<GameCommand>;
  if (
    typeof command.type !== 'string' ||
    !context.allowedCommandTypes.includes(
      command.type as GameCommand['type'],
    ) ||
    !validCommandPayload(command as GameCommand, context)
  ) {
    throw new ProviderError('invalid_output', retryCount);
  }
  const allowedActions = context.allowedActions ?? [];
  const action = actionForCommand(command as GameCommand);
  if (allowedActions.length > 0 && (!action || !allowedActions.includes(action))) {
    throw new ProviderError('invalid_output', retryCount);
  }
  return {
    command: command as GameCommand,
    reason:
      typeof parsed.reason === 'string'
        ? parsed.reason.slice(0, 300)
        : 'provider suggestion',
    providerMeta: { retryCount },
  };
};

const normalizeError = (
  error: unknown,
  retryCount: number,
): AIProviderError => {
  if (error instanceof ProviderError) {
    return new ProviderError(
      error.errorClass,
      Math.max(retryCount, error.retryCount),
      error.status,
    );
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new ProviderError('timeout', retryCount);
  }
  return new ProviderError('network', retryCount);
};

const behaviorInstruction: Record<AIConfig['defaultBehavior'], string> = {
  aggressive: 'Prefer proactive pressure, clear commitments, and decisive legal actions.',
  conservative: 'Prefer information gathering, low-risk legal actions, and preserve optionality.',
  random: 'Keep decisions varied while remaining consistent with the supplied facts and legal actions.',
};

const promptFor = (
  context: AIRequestContext,
  behavior: AIConfig['defaultBehavior'],
) => {
  const projection = context.projectedContext;
  const snapshot = projection?.snapshot;
  const players =
    snapshot?.players ??
    context.players.map((player) => ({
      ...player,
      role:
        player.id === context.playerId ||
        (context.role === 'wolf' && player.role === 'wolf')
          ? player.role
          : null,
      aiConfig: undefined,
    }));
  const gameState = snapshot?.gameState;
  const publicEvents = projection?.publicEvents ?? [];
  const privateEvents = projection?.privateEvents ?? [];
  const rules = projection?.rules ?? {
    id: 'werewolf.v3.default-12p',
    version: 'unknown',
    values: {},
  };
  const experience = projection?.experience ?? '';

  return {
    system: [
      'You are a server-side werewolf game action planner.',
      `Role: ${context.role}.`,
      `Play style: ${behaviorInstruction[behavior]}`,
      'Use only the supplied role-visible context. Do not infer hidden roles.',
      `Ruleset ${rules.id} ${rules.version}: ${JSON.stringify(rules.values)}`,
      experience ? `Behavior reference:\n${experience}` : '',
      'Return JSON only: {"command":{"type":"...","payload":{...}},"reason":"..."}',
      `Allowed command types: ${JSON.stringify(context.allowedCommandTypes)}`,
      `Allowed actions: ${JSON.stringify(context.allowedActions ?? [])}`,
    ]
      .filter(Boolean)
      .join('\n'),
    user: JSON.stringify({
      playerId: context.playerId,
      phase: context.phase,
      stage: context.stage,
      stageRevision: context.stageRevision,
      players: players.map((player) => ({
        id: player.id,
        name: player.name,
        role: player.role,
        isAlive: player.isAlive,
      })),
      gameState,
      publicEvents,
      privateEvents,
    }),
  };
};

export class HttpAIProvider implements AIProvider {
  readonly mode = 'real_ai' as const;
  private readonly settings: ProviderSettings;
  private readonly queue: ProviderQueue;
  private readonly circuitBreaker: AICircuitBreaker;
  private readonly enqueueTimeoutMs: number;
  private readonly telemetry: AITelemetry;
  private readonly safeHttpClient: SafeHttpClient;
  private readonly testTransport: boolean;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly behavior: AIConfig['defaultBehavior'];
  private readonly endpointPolicy: EndpointPolicy;

  constructor(
    config: AIConfig = loadAIConfig(),
    options: HttpAIProviderOptions = {},
  ) {
    this.settings = settingsFor(config, options.endpoint);
    this.behavior = config.defaultBehavior;
    this.queue = options.queue ?? defaultProviderQueue;
    this.circuitBreaker = options.circuitBreaker ?? defaultAICircuitBreaker;
    this.enqueueTimeoutMs = options.enqueueTimeoutMs ?? 5_000;
    this.telemetry = options.telemetry ?? defaultAITelemetry;
    this.telemetry.observeQueue(this.queue);
    this.testTransport = options.fetch !== undefined;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? 2;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.endpointPolicy = options.endpointPolicy ?? new EndpointPolicy();
    const testTransport: SafeHttpTransport | undefined = options.fetch
      ? async ({ url, options: requestOptions }) => options.fetch!(url, requestOptions)
      : undefined;
    this.safeHttpClient = options.safeHttpClient ?? new SafeHttpClient(this.endpointPolicy, {
      transport: testTransport,
    });
  }

  async suggest(context: AIRequestContext): Promise<AISuggestion> {
    const prompt = promptFor(context, this.behavior);
    if (!this.circuitBreaker.allow(this.settings.key)) {
      throw new ProviderError('circuit_open', 0);
    }
    try {
      const suggestion = await this.queue.run(this.settings.key, (signal) =>
        this.requestWithRetries(prompt, context, signal), {
          signal: context.signal,
          enqueueTimeoutMs: this.enqueueTimeoutMs,
        });
      this.circuitBreaker.recordSuccess(this.settings.key);
      return suggestion;
    } catch (error) {
      if (error instanceof AIQueueError) {
        this.circuitBreaker.release(this.settings.key);
        throw error;
      }
      const normalized = normalizeError(error, 0);
      if (this.isBreakerFailure(normalized)) {
        this.circuitBreaker.recordFailure(this.settings.key);
      }
      if (normalized.errorClass === 'cancelled') this.telemetry.recordCancelled();
      if (normalized.errorClass === 'timeout') this.telemetry.recordTimeout();
      throw normalized;
    }
  }

  private async requestWithRetries(
    prompt: { system: string; user: string },
    context: AIRequestContext,
    signal: AbortSignal,
  ): Promise<AISuggestion> {
      let retryCount = 0;
      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        try {
          const response = await this.requestOnce(prompt, signal);
          if (response.status === 429) {
            if (attempt < this.maxRetries) {
              const retryAfterMs = parseRetryAfter(
                response.headers.get('retry-after'),
                this.now,
              );
              const exponentialMs = this.baseDelayMs * 2 ** attempt;
              retryCount += 1;
              this.telemetry.recordRetry();
              await this.sleepWithSignal(Math.max(retryAfterMs, exponentialMs), signal);
              continue;
            }
            throw new ProviderError('rate_limited', retryCount, 429);
          }
          return parseSuggestion(response.data, context, retryCount);
        } catch (error) {
          if (signal.aborted) throw new ProviderError('cancelled', retryCount);
          const normalized = normalizeError(error, retryCount);
          const retryableStatus = [500, 502, 503, 504].includes(normalized.status ?? 0);
          if (retryableStatus && attempt < this.maxRetries) {
            retryCount += 1;
            this.telemetry.recordRetry();
            await this.sleepWithSignal(this.baseDelayMs * 2 ** attempt, signal);
            continue;
          }
          throw normalized;
        }
      }
      throw new ProviderError('rate_limited', retryCount, 429);
  }

  private async requestOnce(
    prompt: { system: string; user: string },
    parentSignal: AbortSignal,
  ): Promise<ResponseEnvelope> {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    if (parentSignal.aborted) throw new ProviderError('cancelled', 0);
    parentSignal.addEventListener('abort', abortFromParent, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderError('timeout', 0));
      }, this.timeoutMs);
    });
    try {
      const response = await Promise.race([
        this.safeHttpClient.request(this.settings.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.settings.apiKey
              ? { Authorization: `Bearer ${this.settings.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: this.settings.model,
            temperature: this.settings.temperature,
            max_tokens: this.settings.maxTokens,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: prompt.system },
              { role: 'user', content: prompt.user },
            ],
          }),
          redirect: 'manual',
          signal: controller.signal,
          endpointContext: {
            provider: this.settings.provider,
            allowReservedTestHost: this.testTransport,
          },
        }),
        timeout,
      ]);
      if (response.status === 429) {
        return { status: response.status, headers: response.headers };
      }
      if (response.status >= 300 && response.status < 400) {
        throw new ProviderError('redirect_blocked', 0, response.status);
      }
      if (!response.ok) {
        throw new ProviderError('http_error', 0, response.status);
      }
      let data: unknown;
      try {
        data = await Promise.race([response.json(), timeout]);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('invalid_response', 0);
      }
      return { status: response.status, headers: response.headers, data };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal.removeEventListener('abort', abortFromParent);
    }
  }

  private async sleepWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new ProviderError('cancelled', 0);
    await Promise.race([
      this.sleep(delayMs),
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new ProviderError('cancelled', 0)), { once: true });
      }),
    ]);
  }

  private isBreakerFailure(error: AIProviderError): boolean {
    return error.errorClass === 'timeout' ||
      error.errorClass === 'rate_limited' ||
      (error.errorClass === 'http_error' && [500, 502, 503, 504].includes(error.status ?? 0));
  }
}
