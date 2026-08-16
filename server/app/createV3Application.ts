import path from 'node:path';
import type { RuntimeConfig } from '../runtimeConfig';
import { FileEventStore } from '../events/fileStore';
import { InMemoryEventStore } from '../events/store';
import { FileRoomRepository } from '../rooms/fileRepository';
import { InMemoryRoomRepository } from '../rooms/repository';
import { FileLifecycleOutbox } from '../rooms/lifecycleOutbox';
import { RoomService } from '../rooms/roomService';
import { FileInsightStore, InMemoryInsightStore } from '../review/insightStore';
import { FileReviewRepository } from '../review/fileReviewRepository';
import { InMemoryReviewRepository } from '../review/reviewRepository';
import { ReviewPipeline, RulesReviewGenerator } from '../review/reviewPipeline';
import type { V3ApplicationPorts } from './ports';

export interface V3Application {
  readonly rooms: RoomService;
  readonly eventStore: NonNullable<V3ApplicationPorts['eventStore']>;
  readonly reviewPipeline: ReviewPipeline;
  start(): Promise<number>;
  close(): Promise<void>;
}

/**
 * The sole V3 service composition root.  Tests/QC replace ports here; they do
 * not construct a second rule engine or a second review worker.
 */
export function createV3Application(
  runtime: RuntimeConfig,
  ports: V3ApplicationPorts = {},
): V3Application {
  const useMemory = runtime.environment === 'test';
  const eventStore = ports.eventStore ?? (
    useMemory
      ? new InMemoryEventStore()
      : new FileEventStore(runtime.eventsFile, {
          environment: runtime.environment,
          deploymentNamespace: runtime.deploymentNamespace,
          dataRoot: runtime.dataDir,
        })
  );
  const roomRepository = ports.roomRepository ?? (
    useMemory
      ? new InMemoryRoomRepository()
      : new FileRoomRepository(runtime.roomsFile, {
          environment: runtime.environment,
          deploymentNamespace: runtime.deploymentNamespace,
          dataRoot: runtime.dataDir,
        })
  );
  const insightStore = ports.insightStore ?? (
    useMemory
      ? new InMemoryInsightStore()
      : new FileInsightStore(runtime.insightsFile, { dataRoot: runtime.dataDir })
  );
  const reviewRepository = ports.reviewRepository ?? (
    useMemory
      ? new InMemoryReviewRepository()
      : new FileReviewRepository(runtime.reviewsFile, { dataRoot: runtime.dataDir })
  );
  const reviewPipeline = ports.reviewPipeline ?? new ReviewPipeline(eventStore, reviewRepository, {
    insightStore,
    generator: ports.reviewGenerator ?? new RulesReviewGenerator(),
    rulesGenerator: ports.reviewGenerator ?? new RulesReviewGenerator(),
    aiGenerator: ports.aiReviewGenerator,
    defaultGenerationMode: ports.reviewGenerationMode ?? 'rules',
  });
  const lifecycleOutbox = ports.lifecycleOutbox ?? (
    useMemory
      ? undefined
      : new FileLifecycleOutbox(path.join(runtime.outboxDir, 'room-lifecycle.json'), {
          environment: runtime.environment,
          deploymentNamespace: runtime.deploymentNamespace,
          dataRoot: runtime.dataDir,
        })
  );
  const rooms = new RoomService(roomRepository, eventStore, {
    ...ports.roomOptions,
    autoDrive: ports.autoDrive ?? ports.roomOptions?.autoDrive ?? runtime.environment !== 'test',
    environment: runtime.environment,
    deploymentNamespace: runtime.deploymentNamespace,
    waitingRoomTtlMs: runtime.waitingRoomTtlMs,
    endedRoomTtlMs: runtime.endedRoomTtlMs,
    roomSweepIntervalMs: runtime.roomSweepIntervalMs,
    startupGraceMs: runtime.startupGraceMs,
    ...(ports.credentialStore ? { credentialStore: ports.credentialStore } : {}),
    ...(lifecycleOutbox ? { lifecycleOutbox } : {}),
    ...(ports.aiProvider ? { aiProvider: ports.aiProvider } : {}),
    ...(ports.aiProviderFactory ? { aiProviderFactory: ports.aiProviderFactory } : {}),
    reviewPipeline,
    insightStore,
  });
  let started = false;
  let restoredCount = 0;
  let closed = false;
  return {
    rooms,
    eventStore,
    reviewPipeline,
    async start() {
      if (closed) throw new Error('V3_APPLICATION_CLOSED');
      if (started) return restoredCount;
      started = true;
      restoredCount = await rooms.restore();
      return restoredCount;
    },
    async close() {
      if (closed) return;
      closed = true;
      await rooms.close();
      await reviewPipeline.close();
    },
  };
}
