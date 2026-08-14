import type { Player, GameState, NightAction, Role } from './types';
import { generateRoleAssignment } from './roleConfig';

/** v2.4.8 任务11 + v2.4.9 任务7：女巫决策解析（容错）——统一解析多种输出格式：
 *  - 标准：`女巫行动: 救人/毒人/跳过 目标`（v2.4.8）
 *  - 明确：`用药: 解药/毒药/不用 + 目标`（v2.4.9 新增主格式）
 *  - 兼容：`用解药救X` / `毒X` / `不用药` 等
 * 解析失败/乱码（round10 "p0"、round11 "p4/p2/p7/p2"）→ 返回 { action: 'unclear' }，
 * 由调用方按合理默认决策处理（有人被刀且女巫活着 → 用解药），而不是永远不用药。 */
export const parseWitchDecision = (
  text: string
): { action: 'heal' | 'poison' | 'skip' | 'unclear'; target: string | null } => {
  const t = (text || '').trim();
  if (!t) return { action: 'unclear', target: null };

  // v2.4.9 主格式：用药: 解药/毒药/不用 + 目标（目标可选）
  const med = t.match(/用药\s*[:：]?\s*(解药|毒药|救人|毒人|不用|不用药|留药|跳过)\s*(\S+)?/);
  if (med) {
    const verb = med[1];
    const target = med[2] || null;
    if (verb === '解药' || verb === '救人') return { action: 'heal', target };
    if (verb === '毒药' || verb === '毒人') return { action: 'poison', target };
    return { action: 'skip', target: null };
  }

  const fmt = t.match(/女巫行动\s*[:：]?\s*(救人|用解药|救|毒人|毒杀|下毒|跳过|不用药|留药|不用)\s*(\S+)?/);
  if (fmt) {
    const verb = fmt[1];
    const target = fmt[2] || null;
    if (verb === '救人' || verb === '用解药' || verb === '救') return { action: 'heal', target };
    if (verb === '毒人' || verb === '毒杀' || verb === '下毒') return { action: 'poison', target };
    return { action: 'skip', target: null };
  }
  // 无格式回退：靠关键词判断
  if (/救人|用解药|救\s|解药/.test(t)) return { action: 'heal', target: null };
  if (/毒人|毒杀|下毒|毒药/.test(t)) return { action: 'poison', target: null };
  // 明确表示不用药/留药
  if (/跳过|不用药|不用|留药|放弃|不救|不毒/.test(t)) return { action: 'skip', target: null };
  // 无法识别的乱码（p1/p2/数字/符号）→ unclear，由调用方按合理默认决策处理
  return { action: 'unclear', target: null };
};


export const generatePlayerId = (): string => {
  return Math.random().toString(36).substring(2, 11);
};

export const generateRoomId = (): string => {
  return Math.random().toString(36).substring(2, 15);
};

export const createPlayer = (
  roomId: string,
  name: string,
  isAI: boolean,
  isHost: boolean,
  order: number
): Player => {
  return {
    id: generatePlayerId(),
    roomId,
    name,
    isAI,
    role: null,
    isAlive: true,
    isHost,
    order,
    isReady: false,
  };
};

export const assignRoles = (players: Player[]): Player[] => {
  const roles = generateRoleAssignment(players.length);
  return players.map((player, index) => ({
    ...player,
    role: roles[index],
  }));
};

export const reassignRole = (players: Player[], targetPlayerId: string): Player[] => {
  const targetPlayer = players.find((p) => p.id === targetPlayerId);
  
  if (!targetPlayer || targetPlayer.role === null) return players;
  
  const currentRole = targetPlayer.role;
  
  // 获取所有玩家的角色（排除当前目标玩家）
  const otherPlayers = players.filter(p => p.id !== targetPlayerId);
  
  // 先去重！确保每个角色只出现一次，避免重复抽取
  const uniqueRoles: Role[] = [];
  const seenRoles = new Set<string>();
  
  otherPlayers.forEach(p => {
    if (p.role !== null && !seenRoles.has(p.role)) {
      seenRoles.add(p.role);
      uniqueRoles.push(p.role);
    }
  });
  
  // 移除当前角色（不要抽到一样的！）
  const availableRoles = uniqueRoles.filter(r => r !== currentRole);
  
  if (availableRoles.length === 0) {
    console.warn('没有可用的新角色可以抽！');
    return players;
  }
  
  // 从去重后的角色中随机选择一个新角色
  const randomIndex = Math.floor(Math.random() * availableRoles.length);
  const newRole = availableRoles[randomIndex];
  
  // 找到拥有新角色的某个玩家，进行交换
  const exchangePlayer = otherPlayers.find(p => p.role === newRole);
  
  if (exchangePlayer) {
    // 交换角色
    return players.map(p => {
      if (p.id === targetPlayerId) return { ...p, role: newRole };
      if (p.id === exchangePlayer.id) return { ...p, role: currentRole };
      return p;
    });
  }
  
  return players;
};

export const forceAssignRole = (players: Player[], targetPlayerId: string, role: Role): Player[] => {
  const targetPlayer = players.find((p) => p.id === targetPlayerId);
  if (!targetPlayer) return players;
  
  const currentRole = targetPlayer.role;
  
  let updatedPlayers = players.map((p) =>
    p.id === targetPlayerId ? { ...p, role } : p
  );
  
  if (currentRole) {
    const otherPlayer = updatedPlayers.find(
      (p) => p.id !== targetPlayerId && p.role === role
    );
    if (otherPlayer) {
      updatedPlayers = updatedPlayers.map((p) =>
        p.id === otherPlayer.id ? { ...p, role: currentRole } : p
      );
    }
  }
  
  return updatedPlayers;
};

export const reassignAllRoles = (players: Player[]): Player[] => {
  return assignRoles(players);
};

export const createInitialGameState = (roomId: string, playerIds: string[]): GameState => {
  return {
    roomId,
    phase: 'waiting',
    day: 1,
    turn: 1,
    votes: {},
    nightActions: [],
    winner: null,
    currentSpeaker: null,
    speakerOrder: [...playerIds].sort(() => Math.random() - 0.5),
    actionDone: {},
    speechTimeLeft: 0,
    actionTimeLeft: 0,
    wolfVotes: {},
    wolfSpeakerOrder: [],
    wolfCurrentSpeaker: null,
    wolfDiscussionRound: 1,
    wolfVoteComplete: false,
    guardianLastTarget: null,
    guardianActionComplete: false,
    witchHasHealPotion: true,
    witchHasPoisonPotion: true,
    witchActionComplete: false,
    lastWordsPlayer: null,
    hunterShootTarget: null,
    witchAntidoteUsed: false,
    // v2.4.3 任务A：白天自由讨论状态机初始为 round1（待 transitionToDay 按存活玩家初始化队列）
    dayPhase: {
      phase: 'round1',
      queue: [],
      interjectQueue: [],
      usedCount: {},
      discussionRounds: 1,
      allSkipped: true,
      interjectedThisRound: [],
      sorterId: null,
    },
    // v2.4.10 任务1：捋人轮换（不能连天同一人）
    lastSorterId: null,
  };
};

export const determineVoteResult = (votes: Record<string, string>): string | null => {
  const voteCount: Record<string, number> = {};
  
  Object.values(votes).forEach((targetId) => {
    if (targetId) {
      voteCount[targetId] = (voteCount[targetId] || 0) + 1;
    }
  });

  let maxVotes = 0;
  let result: string | null = null;
  let hasTie = false;

  Object.entries(voteCount).forEach(([id, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      result = id;
      hasTie = false;
    } else if (count === maxVotes) {
      hasTie = true;
    }
  });

  return hasTie ? null : result;
};

/**
 * v2.4.7b：白天投票结束后「好人仅存 1 人且狼人 ≥1」→ 结局已定，直接判狼胜（跳过夜晚进复盘）。
 * 注意：与 checkWinCondition 的屠边判定解耦——夜晚狼刀后好人剩 1 时**不**调用本函数判负（保留白天抢救空间），
 * 只在白天投票结算路径（applyVoteResult）使用。
 */
export const checkGoodOneLeftWin = (players: Player[]): 'wolf' | null => {
  const alivePlayers = players.filter((p) => p.isAlive);
  const wolfCount = alivePlayers.filter((p) => p.role === 'wolf').length;
  const goodCount = alivePlayers.filter((p) => p.role !== 'wolf').length;
  return wolfCount >= 1 && goodCount === 1 ? 'wolf' : null;
};

export const checkWinCondition = (players: Player[]): 'wolf' | 'good' | null => {
  const alivePlayers = players.filter((p) => p.isAlive);
  const wolfCount = alivePlayers.filter((p) => p.role === 'wolf').length;

  if (wolfCount === 0) {
    return 'good';
  }

  // W1 屠边规则：所有神职死光 或 所有平民死光 → 狼人胜
  const godRoles: Role[] = ['seer', 'witch', 'hunter', 'guardian'];
  const aliveGodCount = alivePlayers.filter((p) => p.role !== null && godRoles.includes(p.role)).length;
  const aliveVillagerCount = alivePlayers.filter((p) => p.role === 'villager').length;

  if (aliveGodCount === 0 || aliveVillagerCount === 0) {
    return 'wolf';
  }

  return null;
};

export const processNightActions = (
  players: Player[],
  nightActions: NightAction[]
): { players: Player[]; killed: string[]; healed: string[]; poisoned: string[]; guarded: string[] } => {
  let newPlayers = [...players];
  const killed: string[] = [];
  const healed: string[] = [];
  const poisoned: string[] = [];
  const guarded: string[] = [];

  // v2.4.8 任务10：严格校验角色存活状态——已死守卫/女巫的行动（残留 save/antidote 未清理等）一律不生效。
  // 依据 nightActions 的 playerId 反查行动者：解药必须由存活女巫发起、守护必须由存活守卫发起、毒药必须由存活女巫发起。
  const actorAlive = (id: string | null | undefined, role: Role): boolean => {
    if (!id) return false;
    const p = players.find((x) => x.id === id);
    return !!p && p.isAlive && p.role === role;
  };

  const killActions = nightActions.filter((a) => a.action === 'kill' && a.targetId);
  const healActions = nightActions.filter(
    (a) => a.action === 'heal' && a.targetId && actorAlive(a.playerId, 'witch')
  );
  const poisonActions = nightActions.filter(
    (a) => a.action === 'poison' && a.targetId && actorAlive(a.playerId, 'witch')
  );
  const guardActions = nightActions.filter(
    (a) => a.action === 'guard' && a.targetId && actorAlive(a.playerId, 'guardian')
  );

  const killTarget = killActions[0]?.targetId;
  const healTarget = healActions[0]?.targetId;
  const poisonTarget = poisonActions[0]?.targetId;
  const guardTarget = guardActions[0]?.targetId;

  // 记录被守卫的目标
  if (guardTarget) {
    guarded.push(guardTarget);
  }

  // 处理女巫的救人
  if (healTarget) {
    healed.push(healTarget);
  }

  if (killTarget) {
    // 检查是否被守卫守护或被女巫救
    const isGuarded = guardTarget === killTarget;
    const isHealed = healTarget === killTarget;
    
    // 狼人杀规则：
    // - 只有女巫救：目标存活
    // - 只有守卫守：目标存活
    // - 女巫救 + 守卫守（同守同救）：目标死亡
    // - 都没有：目标死亡
    
    if (!isGuarded && !isHealed) {
      // 既没有被守卫也没有被救，击杀成功
      newPlayers = newPlayers.map((p) =>
        p.id === killTarget ? { ...p, isAlive: false } : p
      );
      killed.push(killTarget);
    } else if (isGuarded && isHealed) {
      // 同守同救，目标死亡
      newPlayers = newPlayers.map((p) =>
        p.id === killTarget ? { ...p, isAlive: false } : p
      );
      killed.push(killTarget);
    }
    // 只有守卫守或只有女巫救，目标存活，不做处理
  }

  // 处理女巫的毒药
  if (poisonTarget) {
    newPlayers = newPlayers.map((p) =>
      p.id === poisonTarget ? { ...p, isAlive: false } : p
    );
    poisoned.push(poisonTarget);
  }

  return { players: newPlayers, killed, healed, poisoned, guarded };
};

export const getPhaseText = (phase: GameState['phase']): string => {
  const phaseMap: Record<GameState['phase'], string> = {
    waiting: '等待开始',
    roleSelect: '🎴 角色选择',
    night: '🌙 夜晚',
    day: '☀️ 白天',
    vote: '🗳️ 投票',
    voting: '🗳️ 投票中',
    hunterShoot: '🔫 猎人开枪',
    lastWords: '💬 遗言',
    ended: '游戏结束',
  };
  return phaseMap[phase];
};

export const getPlayersByRole = (players: Player[], role: Role): Player[] => {
  return players.filter((p) => p.role === role);
};

export const getAlivePlayers = (players: Player[]): Player[] => {
  return players.filter((p) => p.isAlive);
};

export const getDeadPlayers = (players: Player[]): Player[] => {
  return players.filter((p) => !p.isAlive);
};
