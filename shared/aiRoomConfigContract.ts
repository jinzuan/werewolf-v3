import type {
  RoomAIBehavior,
  RoomAIProvider,
} from './roomContract';
import type { AIProviderCapability } from './aiProviderCapabilities';

/** The only AI settings projection that may cross the room boundary. */
export interface RoomAIConfigSummary {
  provider: RoomAIProvider;
  model: string;
  /** A policy-normalized origin; never includes path, query, userinfo or credentials. */
  endpointOrigin: string;
  temperature: number;
  maxTokens: number;
  behavior: RoomAIBehavior;
  /** Capability is server-resolved; older summaries may omit it. */
  capability?: AIProviderCapability;
  hasCredential: boolean;
  /** A migrated credential is blocked until the owner explicitly rotates it. */
  credentialRotationRequired?: boolean;
  /** @deprecated Compatibility projection for pre-C clients. */
  hasApiKey?: boolean;
  /** @deprecated Compatibility projection for pre-C clients. */
  hasToken?: boolean;
  configRevision: number;
  updatedAt: number;
}

/**
 * A write patch is deliberately not the same shape as the summary. Missing
 * tuning fields retain their current values. Empty secret inputs are ignored;
 * only the explicit clear flags remove a stored secret.
 */
export interface RoomAIConfigPatch {
  provider?: RoomAIProvider;
  model?: string;
  endpoint?: string;
  temperature?: number;
  maxTokens?: number;
  behavior?: RoomAIBehavior;
  credential?: string;
  clearCredential?: boolean;
  /** @deprecated Legacy aliases are migrated at the boundary only. */
  apiKey?: string;
  /** @deprecated Legacy aliases are migrated at the boundary only. */
  token?: string;
  /** @deprecated Legacy aliases are migrated at the boundary only. */
  clearApiKey?: boolean;
  /** @deprecated Legacy aliases are migrated at the boundary only. */
  clearToken?: boolean;
}

export type RoomAIConfigUpdate = RoomAIConfigPatch;
