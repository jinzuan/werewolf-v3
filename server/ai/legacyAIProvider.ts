import { loadAIConfig } from '../config';
import { HttpAIProvider } from './httpProvider';
import type { AIProvider, AISuggestion } from './types';

export class LegacyAIProvider implements AIProvider {
  private readonly delegate: HttpAIProvider;

  constructor(delegate = new HttpAIProvider(loadAIConfig())) {
    this.delegate = delegate;
  }

  async suggest(
    context: Parameters<AIProvider['suggest']>[0],
  ): Promise<AISuggestion> {
    return this.delegate.suggest(context);
  }
}
