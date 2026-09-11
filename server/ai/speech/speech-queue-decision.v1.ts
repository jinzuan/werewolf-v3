export const SPEECH_QUEUE_DECISION_CONTRACT_VERSION =
  'speech-queue-decision.v1' as const;

export interface SpeechQueueRequest {
  contract_version: typeof SPEECH_QUEUE_DECISION_CONTRACT_VERSION;
  result: 'request';
  action: 'request_speech';
  reason_code:
    | 'direct_mention'
    | 'unanswered_question'
    | 'new_role_claim'
    | 'new_vote_change'
    | 'material_disagreement'
    | 'new_private_information';
  trigger_event_ids: string[];
}

export interface SpeechQueueDecline {
  contract_version: typeof SPEECH_QUEUE_DECISION_CONTRACT_VERSION;
  result: 'decline';
  reason_code:
    | 'no_new_information'
    | 'already_queued'
    | 'quota_exhausted'
    | 'same_fingerprint'
    | 'not_addressed';
  trigger_event_ids: [];
}

/** Queue participation is decided before, and independently from, speech planning. */
export type SpeechQueueDecision = SpeechQueueRequest | SpeechQueueDecline;
