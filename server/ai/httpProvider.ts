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
  defaultAILogger,
  type AILogger,
} from './types';
import { buildPromptPipeline } from './promptPipeline';
import { parseAIOutput } from './outputParser';
import { RepeatPolicy, repeatSceneFromContext } from './repeatPolicy';
import { validateProviderSpeech } from './speechValidation';
import {
  buildSpeechQueuePrompt,
  parseSpeechQueueDecision,
} from './speechQueueDecision';
import type { SpeechQueueDecision } from './speech/speech-queue-decision.v1';

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
  /** At most one model-output correction, separate from transport retries. */
  maxCorrectionAttempts?: number;
  repeatPolicy?: RepeatPolicy;
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

const MAX_REDIRECTS = 3;

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

const endpointLabel = (endpoint: string): string => {
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '<invalid-endpoint>';
  }
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

const outputCorrectionMessage = (detail?: string): string =>
  `上一条输出未通过服务端校验（${detail || 'INVALID_OUTPUT'}）。只修正动作、JSON 格式或合法目标，不添加解释。`;

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
    case 'game.request_speech':
      return 'request_speech';
    case 'game.vote':
      return command.payload.targetId === null ? 'abstain' : 'vote';
    case 'game.hunter_shoot':
      return command.payload.targetId === null
        ? 'skip_hunter_shot'
        : 'hunter_shoot';
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
  const finishReason = choices[0].finish_reason;
  if (typeof finishReason === 'string' && finishReason !== 'stop') {
    throw new ProviderError(
      'invalid_output',
      retryCount,
      undefined,
      `INCOMPLETE_OUTPUT:${finishReason}`,
    );
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
  if (error instanceof Error && error.name === 'PromptBuildError') {
    const code = (error as Error & { code?: unknown }).code;
    return new ProviderError(
      'prompt_error',
      retryCount,
      undefined,
      `${typeof code === 'string' ? code : 'PROMPT_BUILD_FAILED'}:${error.message.slice(0, 160)}`,
    );
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
  private readonly maxCorrectionAttempts: number;
  private readonly repeatPolicy: RepeatPolicy;
  private readonly baseDelayMs: number;
  private readonly endpointPolicy: EndpointPolicy;
  private readonly promptBudget: { maxChars?: number; maxEvents?: number };
  private readonly logger: AILogger;

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
    this.maxCorrectionAttempts = Math.max(
      0,
      Math.min(1, options.maxCorrectionAttempts ?? 1),
    );
    this.repeatPolicy = options.repeatPolicy ?? new RepeatPolicy();
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.endpointPolicy = options.endpointPolicy ?? new EndpointPolicy();
    this.promptBudget = {
      maxChars: options.promptMaxChars,
      maxEvents: options.promptMaxEvents,
    };
    this.logger = options.logger ?? defaultAILogger;
    const testTransport: SafeHttpTransport | undefined = options.fetch
      ? async ({ url, options: requestOptions }) => options.fetch!(url, requestOptions)
      : undefined;
    // 生产环境走原生 fetch（正常 DNS）可绕过 SafeHttpClient 的 IP 直连——
    // IP 直连会触发 lingll CDN 的 self-302（Location=自身）导致 AI 全降级模板。
    // 端点仍过 endpointPolicy 校验（协议/端口/私有地址拦截），self-hosted + 固定端点场景
    // 可接受；用 WW_AI_NATIVE_FETCH=1 显式启用，默认保持 DNS-pinning 安全。
    const nativeFetch = process.env.WW_AI_NATIVE_FETCH === '1';
    const nativeTransport: SafeHttpTransport | undefined = options.fetch || !nativeFetch
      ? undefined
      : async ({ url, options: requestOptions }) => fetch(url, requestOptions);
    this.safeHttpClient = options.safeHttpClient ?? new SafeHttpClient(this.endpointPolicy, {
      transport: testTransport ?? nativeTransport,
    });
  }

  async decideSpeechQueue(context: AIRequestContext): Promise<SpeechQueueDecision> {
    const startedAt = this.now();
    const baseLog = {
      roomId: context.roomId,
      gameId: context.gameId,
      playerId: context.playerId,
      callId: context.callId,
      stage: 'speech_queue',
      provider: this.settings.provider,
      model: this.settings.model,
      endpoint: endpointLabel(this.settings.endpoint),
    } as const;
    this.logger({ layer: 'provider', status: 'started', ...baseLog });
    try {
      const prompt = buildSpeechQueuePrompt(context);
      const response = await this.queue.run(
        this.settings.key,
        (signal) => this.requestOnce(prompt, signal),
        { signal: context.signal, enqueueTimeoutMs: this.enqueueTimeoutMs },
      );
      if (response.status === 429) {
        throw new ProviderError('rate_limited', 0, 429);
      }
      const data = response.data;
      const choices = isRecord(data) && Array.isArray(data.choices) ? data.choices : [];
      const finishReason = isRecord(choices[0]) ? choices[0].finish_reason : undefined;
      if (typeof finishReason === 'string' && finishReason !== 'stop') {
        throw new ProviderError('invalid_output', 0, undefined, `INCOMPLETE_OUTPUT:${finishReason}`);
      }
      const message = isRecord(choices[0]) ? choices[0].message : undefined;
      const raw = isRecord(message) && typeof message.content === 'string'
        ? message.content
        : '';
      const parsed = parseSpeechQueueDecision(raw, context);
      if (parsed.ok === false) {
        throw new ProviderError('invalid_output', 0, undefined, parsed.message);
      }
      this.logger({
        layer: 'provider',
        status: 'success',
        ...baseLog,
        commandType: parsed.decision.result === 'request' ? 'game.request_speech' : undefined,
        retryCount: 0,
        durationMs: Math.max(0, this.now() - startedAt),
      });
      return parsed.decision;
    } catch (error) {
      const normalized = normalizeError(error, 0);
      this.logger({
        layer: 'provider',
        status: 'failed',
        ...baseLog,
        errorClass: normalized.errorClass,
        ...(normalized.detail ? { detail: normalized.detail } : {}),
        ...(normalized.status !== undefined ? { httpStatus: normalized.status } : {}),
        retryCount: normalized.retryCount,
        durationMs: Math.max(0, this.now() - startedAt),
      });
      throw normalized;
    }
  }

  async suggest(context: AIRequestContext): Promise<AISuggestion> {
    const startedAt = this.now();
    const baseLog = {
      roomId: context.roomId,
      gameId: context.gameId,
      playerId: context.playerId,
      callId: context.callId,
      stage: context.stage,
      provider: this.settings.provider,
      model: this.settings.model,
      endpoint: endpointLabel(this.settings.endpoint),
    } as const;
    this.logger({ layer: 'provider', status: 'started', ...baseLog });
    try {
      const prompt = buildPromptPipeline(context, this.promptBudget).prompt;
      if (!this.circuitBreaker.allow(this.settings.key)) {
        throw new ProviderError('circuit_open', 0);
      }
      const suggestion = await this.queue.run(this.settings.key, (signal) =>
        this.requestWithRetries(prompt, context, signal), {
          signal: context.signal,
          enqueueTimeoutMs: this.enqueueTimeoutMs,
        });
      this.circuitBreaker.recordSuccess(this.settings.key);
      this.logger({
        layer: 'provider',
        status: 'success',
        ...baseLog,
        commandType: suggestion.command.type,
        retryCount: suggestion.providerMeta?.retryCount ?? 0,
        durationMs: Math.max(0, this.now() - startedAt),
      });
      return suggestion;
    } catch (error) {
      if (error instanceof AIQueueError) {
        this.circuitBreaker.release(this.settings.key);
        this.logger({
          layer: 'provider',
          status: 'failed',
          ...baseLog,
          errorClass: error.code,
          durationMs: Math.max(0, this.now() - startedAt),
        });
        throw error;
      }
      const normalized = normalizeError(error, 0);
      if (this.isBreakerFailure(normalized)) {
        this.circuitBreaker.recordFailure(this.settings.key);
      }
      if (normalized.errorClass === 'cancelled') this.telemetry.recordCancelled();
      if (normalized.errorClass === 'timeout') this.telemetry.recordTimeout();
      this.logger({
        layer: 'provider',
        status: 'failed',
        ...baseLog,
        errorClass: normalized.errorClass,
        ...(normalized.detail ? { detail: normalized.detail } : {}),
        ...(normalized.status !== undefined ? { httpStatus: normalized.status } : {}),
        retryCount: normalized.retryCount,
        durationMs: Math.max(0, this.now() - startedAt),
      });
      throw normalized;
    }
  }

  private async requestWithRetries(
    initialPrompt: { system: string; user: string },
    context: AIRequestContext,
    signal: AbortSignal,
  ): Promise<AISuggestion> {
    let prompt = initialPrompt;
    let retryCount = 0;
    let transportRetries = 0;
    let correctionAttempts = 0;

    const applyCorrection = (instruction: string): void => {
      correctionAttempts += 1;
      retryCount += 1;
      this.telemetry.recordRetry();
      const promptContext = {
        ...(context.promptContext ?? {}),
        validationError: instruction,
        requiredNovelty: instruction,
      };
      prompt = buildPromptPipeline(
        { ...context, promptContext },
        this.promptBudget,
      ).prompt;
    };

    while (true) {
      try {
        const response = await this.requestOnce(prompt, signal);
        if (response.status === 429) {
          if (transportRetries < this.maxRetries) {
            const retryAfterMs = parseRetryAfter(
              response.headers.get('retry-after'),
              this.now,
            );
            const exponentialMs = this.baseDelayMs * 2 ** transportRetries;
            transportRetries += 1;
            retryCount += 1;
            this.telemetry.recordRetry();
            await this.sleepWithSignal(Math.max(retryAfterMs, exponentialMs), signal);
            continue;
          }
          throw new ProviderError('rate_limited', retryCount, 429);
        }

        const suggestion = parseSuggestion(response.data, context, retryCount);
        if (
          suggestion.command.type === 'game.speak' ||
          suggestion.command.type === 'game.wolf_speak'
        ) {
          const speech = suggestion.command.payload.content;
          const speechValidation = validateProviderSpeech(
            speech,
            context,
            suggestion.command.type,
          );
          if (!speechValidation.ok) {
            if (correctionAttempts < this.maxCorrectionAttempts) {
              applyCorrection(speechValidation.rewriteInstruction);
              continue;
            }
            throw new ProviderError(
              'invalid_output',
              retryCount,
              undefined,
              `${speechValidation.category === 'style' ? 'SPEECH_STYLE' : 'SPEECH_GATE'}:${speechValidation.issues.join(',')}`,
            );
          }
          const repeat = this.repeatPolicy.inspect(
            repeatSceneFromContext(context),
            speech,
          );
          if (repeat.repeated) {
            if (correctionAttempts < this.maxCorrectionAttempts) {
              applyCorrection(repeat.guidance);
              continue;
            }
            throw new ProviderError(
              'invalid_output',
              retryCount,
              undefined,
              'REPETITION_DETECTED',
            );
          }
          this.repeatPolicy.record(repeatSceneFromContext(context), speech);
        }
        return suggestion;
      } catch (error) {
        if (signal.aborted) throw new ProviderError('cancelled', retryCount);
        const normalized = normalizeError(error, retryCount);
        if (
          normalized.errorClass === 'invalid_output' &&
          !normalized.detail?.startsWith('SPEECH_STYLE:') &&
          correctionAttempts < this.maxCorrectionAttempts
        ) {
          applyCorrection(outputCorrectionMessage(normalized.detail));
          continue;
        }
        const retryableStatus = [500, 502, 503, 504].includes(normalized.status ?? 0);
        if (retryableStatus && transportRetries < this.maxRetries) {
          const delayMs = this.baseDelayMs * 2 ** transportRetries;
          transportRetries += 1;
          retryCount += 1;
          this.telemetry.recordRetry();
          await this.sleepWithSignal(delayMs, signal);
          continue;
        }
        throw normalized;
      }
    }
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
      const requestOptions = {
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
        redirect: 'manual' as const,
        signal: controller.signal,
        endpointContext: {
          provider: this.settings.provider,
          allowReservedTestHost: this.testTransport,
        },
      };
      const originalEndpoint = new URL(this.settings.endpoint);
      let requestEndpoint = this.settings.endpoint;
      let redirectCount = 0;

      while (true) {
        const response = await Promise.race([
          this.safeHttpClient.request(requestEndpoint, requestOptions),
          timeout,
        ]);
        if (response.status === 429) {
          return { status: response.status, headers: response.headers };
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (redirectCount >= MAX_REDIRECTS) {
            throw new ProviderError(
              'redirect_blocked',
              0,
              response.status,
              `TOO_MANY_REDIRECTS:${location ?? '(no-location)'}`,
            );
          }
          if (!location) {
            throw new ProviderError(
              'redirect_blocked',
              0,
              response.status,
              'MISSING_LOCATION',
            );
          }
          let redirectEndpoint: URL;
          try {
            redirectEndpoint = new URL(location, requestEndpoint);
          } catch {
            throw new ProviderError(
              'redirect_blocked',
              0,
              response.status,
              'INVALID_LOCATION',
            );
          }
          // Never let a provider redirect change the transport scheme or host.
          // SafeHttpClient validates this URL again and pins its DNS answer
          // before every redirected request.
          if (
            redirectEndpoint.protocol !== 'https:' ||
            redirectEndpoint.hostname !== originalEndpoint.hostname
          ) {
            throw new ProviderError(
              'redirect_blocked',
              0,
              response.status,
              `UNSAFE_LOCATION:${redirectEndpoint.hostname}:${redirectEndpoint.pathname}`,
            );
          }
          requestEndpoint = redirectEndpoint.toString();
          redirectCount += 1;
          continue;
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
      }
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
