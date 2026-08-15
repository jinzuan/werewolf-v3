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

/** A safe reference to an authoritative event. It is not the event itself. */
export interface ReviewEvidenceRef {
  eventId: string;
  eventType: string;
  sequence: number;
}

export interface ReviewMessage {
  id: string;
  text: string;
  audience: ReviewAudience;
  team?: ReviewTeam;
  role?: Role;
  evidence: ReviewEvidenceRef[];
}

export interface ReviewInsight {
  id: string;
  role: Role;
  text: string;
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

export interface PostGameReviewView {
  gameId: string;
  roomId: string;
  status: ReviewJobStatus;
  enabled: boolean;
  errorCode?: string;
  timeline: ReviewTimelineEntry[];
  messages: ReviewMessage[];
  insights: ReviewInsight[];
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
}
