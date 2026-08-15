import type { RoomStatus } from '../../../shared/roomContract';
import type { GameState } from '../../../shared/types';

/** The visual scene is a projection of server facts, never a client clock. */
export type RoomScene = 'lobby' | 'dusk' | 'night' | 'dawn' | 'day' | 'ended';

export interface AuthoritativeSceneInput {
  roomStatus?: RoomStatus | null;
  phase?: GameState['phase'] | string | null;
  stage?: string | null;
}

const isNightPhase = (phase: string | null | undefined): boolean => phase === 'night';

/**
 * Resolve the scene from the latest authoritative room/game projection.
 * `stage` is intentionally a string because the day-stage contract is still
 * optional in older snapshots; unknown values fall back to the safe day scene.
 */
export const resolveRoomScene = ({
  roomStatus,
  phase,
  stage,
}: AuthoritativeSceneInput): RoomScene => {
  if (roomStatus === 'ended' || phase === 'ended') return 'ended';
  if (roomStatus === 'starting') return 'dusk';
  if (!phase || phase === 'waiting') return roomStatus === 'ready_check' ? 'dusk' : 'lobby';
  if (phase === 'roleSelect') return 'dusk';
  if (isNightPhase(phase)) return 'night';
  if (stage === 'dawn' || phase === 'dawn') return 'dawn';
  return 'day';
};

export const sceneForRoom = (
  roomStatus: RoomStatus | null | undefined,
  gameState?: (Pick<GameState, 'phase' | 'nightStage'> & { stage?: string | null }) | null,
): RoomScene => resolveRoomScene({
  roomStatus,
  phase: gameState?.phase,
  stage: gameState?.stage ?? gameState?.nightStage,
});

export const getRoomScene = resolveRoomScene;
export const sceneFromAuthoritativeState = resolveRoomScene;

export const ROOM_SCENE_LABELS: Record<RoomScene, string> = {
  lobby: '日暮村庄',
  dusk: '蓝调黄昏',
  night: '月下森林',
  dawn: '黎明村庄',
  day: '篝火广场',
  ended: '黎明村庄',
};
