import type { GameCommand } from '../../shared/protocol';
import type { GameAction } from '../../shared/types';
import { AI_TIMEOUT_MS, type ServerAIConfig } from './config';
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
import {
  AIProviderError as ProviderError,
  type AILogger,
} from './types';
import { buildPromptPipeline } from './promptPipeline';
import { parseAIOutput } from './outputParser';

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
  promptMaxChars?: number;
  promptMaxEvents?: number;
  logger?: AILogger;
}

interface ResponseEnvelope {
  status: number;
  headers: Headers;
  data?: unknown;
}

const endpointFor = (config: ServerAIConfig): string => {
  if (config.apiType === 'siliconflow') {
    return 'https://api.siliconflow.cn/v1/chat/completions';
  }
  if (config.apiType === 'deepseek') {
    return 'https://api.deepseek.com/v1/chat/completions';
  }
  return config.local.apiUrl;
};

const settingsFor = (config: ServerAIConfig, endpointOverride?: string): ProviderSettings => {
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
    case 'game.confirm_role':
      return 'confirm_role';
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
    case 'game.confirm_role':
      return true;
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
      return (
        validTarget(command.payload.targetId) &&
        (command.payload.reason === undefined || typeof command.payload.reason === 'string')
      );
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

  const parserContext = {
    allowedCommandTypes: context.allowedCommandTypes,
    players: context.players,
    playerId: context.playerId,
    role: context.role,
    phase: context.phase,
    stage: context.stage,
    promptContext: {
      ...(context.promptContext ?? {}),
      legalActions: context.promptContext?.legalActions ?? context.allowedActions ?? [],
      legalTargets: context.promptContext?.legalTargets ?? context.players
        .filter((player) => player.isAlive)
        .map((player) => ({ id: player.id, name: player.name })),
    },
  };
  const parsedOutput = parseAIOutput(message.content, parserContext);
  if (parsedOutput.ok === false) {
    throw new ProviderError('invalid_output', retryCount, undefined, parsedOutput.code);
  }
  const allowedActions = context.allowedActions ?? [];
  const action = actionForCommand(parsedOutput.command);
  if (allowedActions.length > 0 && (!action || !allowedActions.includes(action))) {
    throw new ProviderError('invalid_output', retryCount, undefined, 'ACTION_NOT_ALLOWED');
  }
  return {
    command: parsedOutput.command,
    reason: parsedOutput.reason.slice(0, 300),
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
      error.detail,
    );
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new ProviderError('timeout', retryCount);
  }
  return new ProviderError('network', retryCount);
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
  private readonly endpointPolicy: EndpointPolicy;
  private readonly promptBudget: { maxChars?: number; maxEvents?: number };

  constructor(
    config: ServerAIConfig = loadAIConfig(),
    options: HttpAIProviderOptions = {},
  ) {
    this.settings = settingsFor(config, options.endpoint);
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
    this.promptBudget = {
      maxChars: options.promptMaxChars,
      maxEvents: options.promptMaxEvents,
    };
    const testTransport: SafeHttpTransport | undefined = options.fetch
      ? async ({ url, options: requestOptions }) => options.fetch!(url, requestOptions)
      : undefined;
    this.safeHttpClient = options.safeHttpClient ?? new SafeHttpClient(this.endpointPolicy, {
      transport: testTransport,
    });
  }

  async suggest(context: AIRequestContext): Promise<AISuggestion> {
    const prompt = buildPromptPipeline(context, this.promptBudget).prompt;
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
