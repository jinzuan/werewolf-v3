import type { Role } from '../../shared/types';
import type { RoomScene } from '../features/room-shell/scene';

import roleGuard from '../assets/v31/roles/role-guard.svg';
import roleHunter from '../assets/v31/roles/role-hunter.svg';
import roleSeer from '../assets/v31/roles/role-seer.svg';
import roleVillager from '../assets/v31/roles/role-villager.svg';
import roleWitch from '../assets/v31/roles/role-witch.svg';
import roleWolf from '../assets/v31/roles/role-wolf.svg';
import avatarComputer from '../assets/v31/avatars/avatar-computer.svg';
import avatarPlayer from '../assets/v31/avatars/avatar-player.svg';
import avatarSpectator from '../assets/v31/avatars/avatar-spectator.svg';
import moonPhases from '../assets/v31/moon-phases.svg';

export interface VisualAsset {
  src: string;
  label: string;
}

export const roleAssetMap: Record<Role, VisualAsset> = {
  wolf: { src: roleWolf, label: '狼人徽章' },
  seer: { src: roleSeer, label: '预言家徽章' },
  witch: { src: roleWitch, label: '女巫徽章' },
  hunter: { src: roleHunter, label: '猎人徽章' },
  guardian: { src: roleGuard, label: '守卫徽章' },
  villager: { src: roleVillager, label: '村民徽章' },
};

export type AvatarKind = 'player' | 'computer' | 'spectator';

export const avatarAssetMap: Record<AvatarKind, VisualAsset> = {
  player: { src: avatarPlayer, label: '玩家头像' },
  computer: { src: avatarComputer, label: '电脑玩家头像' },
  spectator: { src: avatarSpectator, label: '观战者头像' },
};

/** The sprite remains one local asset so the header never depends on a CDN. */
export const phaseAssetMap: Record<RoomScene, VisualAsset> = {
  lobby: { src: moonPhases, label: '月相：新月前的村庄' },
  dusk: { src: moonPhases, label: '月相：黄昏入席' },
  night: { src: moonPhases, label: '月相：月下行动' },
  dawn: { src: moonPhases, label: '月相：黎明将至' },
  day: { src: moonPhases, label: '月相：篝火白昼' },
  ended: { src: moonPhases, label: '月相：黎明复盘' },
};

export const getRoleAsset = (role: Role): VisualAsset => roleAssetMap[role];
export const getAvatarAsset = (kind: AvatarKind): VisualAsset => avatarAssetMap[kind];
