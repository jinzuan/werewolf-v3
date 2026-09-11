import type { Role } from './types';

/** Durable state of the post-game review job. */
export const REVIEW_JOB_STATUSES = [
  'disabled',
  'pending',
  'running',
  'completed',
  'failed',
] as const;

export type ReviewJobStatus = (typeof REVIEW_JOB_STATUSES)[number];

export type ReviewAudience = 'public' | 'team' | 'role';
export type ReviewTeam = 'wolf' | 'good';
export type ReviewGenerationMode = 'ai' | 'rules';
export type ReviewRound = 'team' | 'global' | 'self';

export type ReviewDeathCause = 'night_kill' | 'vote' | 'poison' | 'hunter_shot';

/** A safe reference to an authoritative event. It is not the event itself. */
export interface ReviewEvidenceRef {
  eventId: string;
  eventType: string;
  sequence: number;
}

export interface ReviewMessage {
  id: string;
  operationId: string;
  text: string;
  audience: ReviewAudience;
  /** Which of the three post-game passes produced this message. */
  round?: ReviewRound;
  playerId?: string;
  team?: ReviewTeam;
  role?: Role;
  evidence: ReviewEvidenceRef[];
}

export interface ReviewInsight {
  id: string;
  operationId: string;
  role: Role;
  /** Self reviews are scoped to one AI, never to the whole role. */
  round?: ReviewRound;
  playerId?: string;
  experienceInstanceId?: string;
  text: string;
  experienceUpdate?: string;
  evidence: ReviewEvidenceRef[];
  createdAt: number;
}

/** Timeline entries contain references and safe summaries only. */
export interface ReviewTimelineEntry {
  eventId: string;
  eventType: string;
  sequence: number;
  occurredAt: number;
  summary: string;
}

/** Death records are only attached to an authorized post-game god view. */
export interface ReviewDeathRecord {
  playerId: string;
  name: string;
  role: Role | null;
  cause: ReviewDeathCause;
  day: number;
  sequence: number;
  eventId: string;
  occurredAt: number;
}

/** Explicit post-game god-view allowlist; experience assignment data is server-only. */
export interface ReviewPlayerView {
  id: string;
  name: string;
  role: Role | null;
  isAI: boolean;
  isAlive: boolean;
  order: number;
}

export interface PostGameReviewView {
  gameId: string;
  roomId: string;
  status: ReviewJobStatus;
  enabled: boolean;
  generationMode: ReviewGenerationMode;
  operationId: string;
  errorCode?: string;
  timeline: ReviewTimelineEntry[];
  messages: ReviewMessage[];
  insights: ReviewInsight[];
  /** Present when the caller explicitly requested the ended-game god view. */
  omniscient?: boolean;
  players?: ReviewPlayerView[];
  deaths?: ReviewDeathRecord[];
  updatedAt: number;
}

/** Internal generator input; it never crosses the socket boundary. */
export interface ReviewArchivePlayer {
  id: string;
  name: string;
  role: Role | null;
  isAI: boolean;
  isAlive: boolean;
  order: number;
  /** Server-only assignment references used by the self-review pass. */
  experienceInstanceId?: string;
  experienceAssetId?: string;
  experienceText?: string;
}
