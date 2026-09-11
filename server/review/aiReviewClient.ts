import type { SafeHttpClient } from '../security/safeHttpClient';
import { loadAIConfig } from '../config';
import { AIReviewGenerator, type AIReviewCompletionClient } from './aiReviewGenerator';

const endpointFor = (config: ReturnType<typeof loadAIConfig>): string => {
  if (config.apiType === 'siliconflow') return 'https://api.siliconflow.cn/v1/chat/completions';
  if (config.apiType === 'deepseek') return 'https://api.deepseek.com/v1/chat/completions';
  return config.local.apiUrl;
};

/**
 * Creates the review generator only when a deployment-level LLM credential is
 * available. No credential is copied into a room, event, review archive, or
 * browser response.
 */
export const createConfiguredAIReviewGenerator = (
  safeHttpClient: SafeHttpClient,
): AIReviewGenerator | undefined => {
  const config = loadAIConfig();
  const selected = config[config.apiType];
  if (!selected.apiKey.trim() || !selected.model.trim()) return undefined;
  const endpoint = endpointFor(config);
  const client: AIReviewCompletionClient = {
    complete: async (prompt) => {
      const response = await safeHttpClient.request(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${selected.apiKey}`,
        },
        body: JSON.stringify({
          model: selected.model,
          temperature: Math.min(.5, Math.max(.1, selected.temperature)),
          max_tokens: Math.min(1200, Math.max(256, selected.maxTokens)),
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        }),
        redirect: 'manual',
      });
      if (!response.ok) throw new Error(`REVIEW_AI_HTTP_${response.status}`);
      const body = await response.json() as unknown;
      if (!body || typeof body !== 'object' || !Array.isArray((body as Record<string, unknown>).choices)) {
        throw new Error('REVIEW_AI_INVALID_RESPONSE');
      }
      const choice = (body as { choices: Array<{ message?: { content?: unknown } }> }).choices[0];
      const content = choice?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('REVIEW_AI_INVALID_RESPONSE');
      return content;
    },
  };
  return new AIReviewGenerator(client);
};
