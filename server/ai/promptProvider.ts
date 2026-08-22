import type { AIPrompt } from './promptBuilder';
import { parseAIOutput } from './outputParser';
import { buildPromptPipeline } from './promptPipeline';
import { RepeatPolicy, repeatSceneFromContext } from './repeatPolicy';
import { inspectSpeechStyle } from './speechStyleGate';
import type {
  AIProvider,
  AIRequestContext,
  AISuggestion,
} from './types';

export interface AICompletionClient {
  complete(prompt: AIPrompt, context: AIRequestContext): Promise<string>;
}

export interface PromptAIProviderOptions {
  repeatPolicy?: RepeatPolicy;
  maxCorrectionAttempts?: number;
}

const correctionMessage = (message: string): string =>
  `上一条输出未通过服务端校验：${message}。只修正动作、格式或合法目标，不重新分析，不添加解释。`;

export class PromptAIProvider implements AIProvider {
  private readonly repeatPolicy: RepeatPolicy;
  private readonly maxCorrectionAttempts: number;

  constructor(
    private readonly client: AICompletionClient,
    options: PromptAIProviderOptions = {},
  ) {
    this.repeatPolicy = options.repeatPolicy ?? new RepeatPolicy();
    this.maxCorrectionAttempts = Math.max(
      0,
      Math.min(1, options.maxCorrectionAttempts ?? 1),
    );
  }

  async suggest(context: AIRequestContext): Promise<AISuggestion> {
    let correction = '';
    for (let attempt = 0; attempt <= this.maxCorrectionAttempts; attempt += 1) {
      const promptContext = {
        ...(context.promptContext ?? {}),
        validationError: correction || context.promptContext?.validationError,
        requiredNovelty:
          correction || context.promptContext?.requiredNovelty,
      };
      const prompt = buildPromptPipeline({ ...context, promptContext }).prompt;
      const raw = await this.client.complete(prompt, {
        ...context,
        promptContext,
      });
      const parsed = parseAIOutput(raw, {
        allowedCommandTypes: context.allowedCommandTypes,
        players: context.players,
        playerId: context.playerId,
        role: context.role,
        phase: context.phase,
        stage: context.stage,
        promptContext,
      });
      if (parsed.ok === false) {
        if (attempt < this.maxCorrectionAttempts) {
          correction = correctionMessage(parsed.message);
          continue;
        }
        throw new Error(`AI_OUTPUT_${parsed.code}`);
      }

      if (RepeatPolicy.isSpeechCommand(parsed.command.type) && parsed.speechText) {
        const style = inspectSpeechStyle(parsed.speechText, {
          commandType: parsed.command.type,
          role: context.role,
          phase: context.phase,
          stage: context.stage,
          players: context.players,
          promptContext,
        });
        if (!style.ok) {
          if (attempt < this.maxCorrectionAttempts) {
            correction = style.rewriteInstruction;
            continue;
          }
          throw new Error(`AI_SPEECH_STYLE_${style.issues.join('_')}`);
        }
        const scene = repeatSceneFromContext(context);
        const repeat = this.repeatPolicy.inspect(scene, parsed.speechText);
        if (repeat.repeated) {
          if (attempt < this.maxCorrectionAttempts) {
            correction = repeat.guidance;
            continue;
          }
          throw new Error('AI_REPETITION_DETECTED');
        }
        this.repeatPolicy.record(scene, parsed.speechText);
      }

      return {
        command: parsed.command,
        reason: parsed.reason,
        providerMeta: { retryCount: attempt },
      };
    }
    throw new Error('AI_OUTPUT_RETRY_EXHAUSTED');
  }

  resetRepeatPolicy(): void {
    this.repeatPolicy.reset();
  }
}
