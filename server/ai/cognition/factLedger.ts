import type { DomainEvent } from '../../../shared/events';
import { sourceRefForEvent } from './gates';
import type { FactKind, FactRecord, OwnerCognition } from './types';

const writeFact = (
  owner: OwnerCognition,
  event: DomainEvent,
  field: string,
  kind: FactKind,
  value: FactRecord['value'],
  subjectId?: string,
  objectId?: string,
): void => {
  const id = `fact:${event.eventId}:${field}`;
  if (owner.facts.byId[id]) return;
  owner.facts.byId[id] = {
    id,
    kind,
    value,
    ...(subjectId ? { subjectId } : {}),
    ...(objectId ? { objectId } : {}),
    certainty: 'authoritative',
    source: sourceRefForEvent(event),
  };
  owner.facts.orderedIds.push(id);
};

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export const reduceFactLedger = (owner: OwnerCognition, event: DomainEvent): void => {
  const payload = event.payload;
  switch (event.eventType) {
    case 'game.started':
      writeFact(owner, event, 'started', 'game_started', true);
      break;
    case 'day.started':
      writeFact(owner, event, 'day', 'day_started', numberValue(payload.day) ?? 0);
      break;
    case 'player.exited': {
      const playerId = stringValue(payload.playerId);
      if (playerId) writeFact(owner, event, 'alive', 'player_alive_changed', false, playerId);
      break;
    }
    case 'seer.result': {
      const targetId = stringValue(payload.targetId);
      const alignment = payload.alignment === 'wolf' || payload.alignment === 'good'
        ? payload.alignment
        : undefined;
      if (targetId && alignment) {
        writeFact(owner, event, 'alignment', 'seer_alignment_result', alignment, targetId);
      }
      break;
    }
    case 'guardian.completed': {
      const targetId = stringValue(payload.targetId);
      if (targetId) writeFact(owner, event, 'target', 'guardian_action', true, event.actorId, targetId);
      break;
    }
    case 'witch.kill_notice': {
      const targetId = stringValue(payload.targetId);
      writeFact(owner, event, 'notice', 'witch_notice', targetId ?? null, targetId);
      break;
    }
    case 'witch.completed': {
      const targetId = stringValue(payload.targetId);
      const action = stringValue(payload.action) ?? 'completed';
      writeFact(owner, event, 'action', 'witch_action', action, event.actorId, targetId);
      break;
    }
    case 'day.exile_result':
    case 'day.revote_required':
    case 'day.no_exile': {
      const exiledId = stringValue(payload.exiledId) ?? stringValue(payload.playerId) ?? null;
      writeFact(owner, event, 'result', 'vote_result', exiledId);
      break;
    }
    case 'day.exiled': {
      const playerId = stringValue(payload.playerId);
      if (playerId) writeFact(owner, event, 'alive', 'player_alive_changed', false, playerId);
      break;
    }
    case 'hunter.shot': {
      const targetId = stringValue(payload.targetId);
      writeFact(owner, event, 'shot', 'hunter_result', targetId ?? null, event.actorId, targetId);
      if (targetId) writeFact(owner, event, 'alive', 'player_alive_changed', false, targetId);
      break;
    }
    case 'hunter.shot_skipped':
      writeFact(owner, event, 'shot', 'hunter_result', null, event.actorId);
      break;
    case 'wolf.kill_locked': {
      const targetId = stringValue(payload.targetId);
      if (targetId) writeFact(owner, event, 'target', 'wolf_kill_locked', targetId, targetId);
      break;
    }
    case 'night.resolved': {
      const deaths = Array.isArray(payload.deaths)
        ? payload.deaths.filter((id): id is string => typeof id === 'string')
        : [];
      writeFact(owner, event, 'result', 'night_public_result', deaths);
      for (const playerId of deaths) {
        writeFact(owner, event, `alive:${playerId}`, 'player_alive_changed', false, playerId);
      }
      break;
    }
    default:
      break;
  }
};
