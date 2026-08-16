import type { EventStore } from '../../shared/events';
import type { ServerAIConfig as AIConfig } from '../ai/config';
import type { InsightStore } from '../review/insightStore';
import type { ReviewGenerator, ReviewPipeline } from '../review/reviewPipeline';
import type { ReviewRepository } from '../review/reviewRepository';
import type { AIProvider } from '../ai/types';
import type { HttpAIProviderOptions } from '../ai/httpProvider';
import type { RoomRepository } from '../rooms/repository';
import type { RoomServiceOptions } from '../rooms/roomService';
import type { RoomCredentialStore } from '../security/roomCredentialStore';
import type { LifecycleOutbox } from '../rooms/lifecycleOutbox';

export interface V3ApplicationPorts {
  eventStore?: EventStore;
  roomRepository?: RoomRepository;
  reviewRepository?: ReviewRepository;
  insightStore?: InsightStore;
  credentialStore?: RoomCredentialStore;
  lifecycleOutbox?: LifecycleOutbox;
  aiProvider?: AIProvider;
  aiProviderFactory?: (config: AIConfig, options: HttpAIProviderOptions) => AIProvider;
  reviewPipeline?: ReviewPipeline;
  reviewGenerator?: ReviewGenerator;
  aiReviewGenerator?: ReviewGenerator;
  roomOptions?: Omit<RoomServiceOptions, 'reviewPipeline' | 'insightStore' | 'credentialStore' | 'lifecycleOutbox' | 'aiProvider' | 'aiProviderFactory'>;
  autoDrive?: boolean;
  reviewGenerationMode?: 'ai' | 'rules';
}
