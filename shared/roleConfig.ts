import type { Role, RoleInfo } from './types';

export const ROLES: RoleInfo[] = [
  {
    name: '狼人',
    role: 'wolf',
    team: 'wolf',
    description: '每晚可以杀死一名玩家',
    icon: '🐺',
  },
  {
    name: '预言家',
    role: 'seer',
    team: 'good',
    description: '每晚可以查验一名玩家的身份',
    icon: '🔮',
  },
  {
    name: '女巫',
    role: 'witch',
    team: 'good',
    description: '拥有解药和毒药各一瓶，可以救人或毒人',
    icon: '🧙',
  },
  {
    name: '猎人',
    role: 'hunter',
    team: 'good',
    description: '被投票出局时可以开枪带走一人',
    icon: '🔫',
  },
  {
    name: '守卫',
    role: 'guardian',
    team: 'good',
    description: '每晚可以守护一名玩家免受狼人袭击，但不能连续两晚守同一人',
    icon: '🛡️',
  },
  {
    name: '平民',
    role: 'villager',
    team: 'good',
    description: '没有特殊技能，只能白天投票',
    icon: '👤',
  },
];

export const getRoleInfo = (role: Role): RoleInfo => {
  return ROLES.find((r) => r.role === role) || ROLES[4];
};

export const generateRoleAssignment = (playerCount: number): Role[] => {
  const roles: Role[] = [];
  let wolfCount = 0;
  let seerCount = 0;
  let witchCount = 0;
  let hunterCount = 0;
  let guardianCount = 0;

  if (playerCount >= 4) {
    wolfCount = Math.floor(playerCount / 3);
    seerCount = 1;
    witchCount = playerCount >= 6 ? 1 : 0;
    hunterCount = playerCount >= 7 ? 1 : 0;
    guardianCount = playerCount >= 6 ? 1 : 0; // 守卫在6人或以上时出现
  }

  for (let i = 0; i < wolfCount; i++) {
    roles.push('wolf');
  }
  if (seerCount > 0) roles.push('seer');
  if (witchCount > 0) roles.push('witch');
  if (hunterCount > 0) roles.push('hunter');
  if (guardianCount > 0) roles.push('guardian');

  while (roles.length < playerCount) {
    roles.push('villager');
  }

  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  return roles;
};

export const ROLE_COLORS: Record<Role, string> = {
  wolf: 'text-red-500',
  seer: 'text-blue-400',
  witch: 'text-purple-400',
  hunter: 'text-orange-400',
  guardian: 'text-cyan-400',
  villager: 'text-gray-300',
};

export const TEAM_COLORS: Record<'wolf' | 'good', string> = {
  wolf: 'bg-red-500/20 border-red-500',
  good: 'bg-blue-500/20 border-blue-500',
};
