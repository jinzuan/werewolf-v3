import type { GameCommand, GameCommandMeta } from '../../shared/protocol';
import type { Player, Role } from '../../shared/types';
import type { GameSession } from '../session/gameSession';

export const roles: readonly Role[] = [
  'guardian',
  'seer',
  'wolf',
  'wolf',
  'wolf',
  'wolf',
  'witch',
  'hunter',
  'villager',
  'villager',
  'villager',
  'villager',
];

export const createPlayers = (roomId = 'room-1'): Player[] =>
  roles.map((role, index) => ({
    id: `${role}-${index + 1}`,
    roomId,
    name: `${role}-${index + 1}`,
    isAI: false,
    role,
    isAlive: true,
    isHost: index === 0,
    order: index + 1,
    isReady: true,
  }));

let commandSequence = 0;

export const dispatch = (
  session: GameSession,
  actorId: string,
  command: GameCommand,
) => {
  commandSequence += 1;
  const meta: GameCommandMeta = {
    commandId: `test-${commandSequence}`,
    actorId,
    sentAt: Date.now(),
    roomId: session.serialize().state.roomId,
    gameId: session.gameId,
    expectedStageRevision: session.stageRevision,
  };
  return session.dispatch(meta, command);
};
