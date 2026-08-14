import { Moon, Target, Eye, Heart, Skull, CheckCircle2, Circle } from 'lucide-react';
import { useGameStore } from '../stores/gameStore';
import { PlayerCard } from './PlayerCard';
import { getRoleInfo } from '../utils/roleConfig';
import type { Role } from '../types';

interface NightActionPanelProps {
  onAction: (action: 'kill' | 'check' | 'heal' | 'poison' | 'guard', targetId: string) => void;
  onSkip: () => void;
}

export const NightActionPanel = ({ onAction, onSkip }: NightActionPanelProps) => {
  const { players, myRole, currentUser, gameState, wolfKillComplete, wolfKillTarget, isSpectator } = useGameStore();
  
  // 观战模式下隐藏行动面板
  if (isSpectator) {
    return (
      <div className="card-glass p-4 text-center">
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-gradient-to-br from-gray-500/20 to-gray-600/10 flex items-center justify-center">
          <Moon className="w-6 h-6 text-gray-400" />
        </div>
        <p className="text-wolf-text/60">观战模式</p>
        <p className="text-sm text-wolf-text/40 mt-1">夜间行动对观战者不可见</p>
      </div>
    );
  }
  const alivePlayers = players.filter((p) => p.isAlive && p.id !== currentUser?.id);
  
  // 找到当前玩家在玩家列表中的真实对象
  const myPlayer = players.find(p => p.id === currentUser?.id) || players.find(p => p.name === currentUser?.name);
  const myPlayerId = myPlayer?.id || currentUser?.id || '';
  
  const roleInfo = myRole ? getRoleInfo(myRole) : null;
  // 使用玩家列表中的真实ID来检查行动是否完成
  const hasAction = gameState?.actionDone[myPlayerId] || (myRole === 'guardian' && gameState?.guardianActionComplete);
  
  const isWitchWaiting = myRole === 'witch' && !wolfKillComplete;
  
  const witchHasHealPotion = gameState?.witchHasHealPotion ?? true;
  const witchHasPoisonPotion = gameState?.witchHasPoisonPotion ?? true;

  const getAvailableActions = (role: Role) => {
    switch (role) {
      case 'wolf':
        return [{ action: 'kill' as const, label: '杀人', icon: Target, color: 'text-red-400', bg: 'from-red-500/20 to-red-600/10' }];
      case 'seer':
        return [{ action: 'check' as const, label: '查验', icon: Eye, color: 'text-blue-400', bg: 'from-blue-500/20 to-blue-600/10' }];
      case 'witch':
        return [
          { action: 'heal' as const, label: '使用解药', icon: Heart, color: 'text-green-400', bg: 'from-green-500/20 to-green-600/10' },
          { action: 'poison' as const, label: '使用毒药', icon: Skull, color: 'text-purple-400', bg: 'from-purple-500/20 to-purple-600/10' },
        ];
      case 'guardian':
        return [{ action: 'guard' as const, label: '守护', icon: Target, color: 'text-yellow-400', bg: 'from-yellow-500/20 to-yellow-600/10' }];
      default:
        return [];
    }
  };

  const actions = myRole ? getAvailableActions(myRole) : [];

  const getActionProgress = () => {
    if (!gameState || gameState.phase !== 'night') return null;
    
    const aliveWolves = players.filter(p => p.isAlive && p.role === 'wolf');
    const aliveSeers = players.filter(p => p.isAlive && p.role === 'seer');
    const aliveWitches = players.filter(p => p.isAlive && p.role === 'witch');
    const aliveGuardians = players.filter(p => p.isAlive && p.role === 'guardian');
    
    let totalCount = 0;
    let actedCount = 0;
    
    if (aliveWolves.length > 0) {
      totalCount++;
      if (gameState.actionDone['wolf_team'] || wolfKillComplete) {
        actedCount++;
      }
    }
    if (aliveGuardians.length > 0) {
      totalCount++;
      const guardianActed = aliveGuardians.some(g => gameState.actionDone[g.id]) || gameState.guardianActionComplete;
      if (guardianActed) {
        actedCount++;
      }
    }
    if (aliveSeers.length > 0) {
      totalCount++;
      const seerActed = aliveSeers.some(s => gameState.actionDone[s.id]);
      if (seerActed) {
        actedCount++;
      }
    }
    if (aliveWitches.length > 0) {
      totalCount++;
      const witchActed = aliveWitches.some(w => gameState.actionDone[w.id]) || gameState.witchActionComplete;
      if (witchActed) {
        actedCount++;
      }
    }
    
    return { actedCount, totalCount };
  };

  const isWolf = myRole === 'wolf';
  const hasNightAction = ['wolf', 'seer', 'witch', 'guardian'].includes(myRole || '');

  const progress = getActionProgress();

  return (
    <div className="card-glass overflow-hidden">
      <div className="px-4 py-3 border-b border-wolf-purple/15 glass-highlight">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500/30 to-purple-500/20 flex items-center justify-center">
            <Moon className="w-4 h-4 text-indigo-300" />
          </div>
          <h3 className="font-semibold text-wolf-text">夜晚行动</h3>
        </div>
      </div>

      <div className="p-4">
        {progress && progress.totalCount > 0 && (
          <div className="mb-4 p-3 rounded-xl bg-wolf-purple/5 border border-wolf-purple/15">
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="text-wolf-text/50">行动进度</span>
              <span className="text-wolf-text font-medium">{progress.actedCount}/{progress.totalCount}</span>
            </div>
            <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-wolf-purple to-wolf-purple-light transition-all duration-500 rounded-full"
                style={{ width: `${(progress.actedCount / progress.totalCount) * 100}%` }}
              />
            </div>
            <div className="flex flex-wrap gap-2 mt-3">
              {(() => {
                const aliveWolves = players.filter(p => p.isAlive && p.role === 'wolf');
                const aliveSeers = players.filter(p => p.isAlive && p.role === 'seer');
                const aliveWitches = players.filter(p => p.isAlive && p.role === 'witch');
                const aliveGuardians = players.filter(p => p.isAlive && p.role === 'guardian');
                
                const teams = [];
                
                if (aliveWolves.length > 0) {
                  const wolfDone = gameState?.actionDone['wolf_team'] || wolfKillComplete;
                  teams.push({
                    role: 'wolf',
                    done: wolfDone,
                    displayName: '狼人',
                    displayIcon: '🐺'
                  });
                }
                
                if (aliveGuardians.length > 0) {
                  const guardianDone = aliveGuardians.some(g => gameState?.actionDone[g.id]) || gameState?.guardianActionComplete;
                  teams.push({
                    role: 'guardian',
                    done: guardianDone,
                    displayName: '守卫',
                    displayIcon: '🛡️'
                  });
                }
                
                if (aliveSeers.length > 0) {
                  const seerDone = aliveSeers.some(s => gameState?.actionDone[s.id]);
                  teams.push({
                    role: 'seer',
                    done: seerDone,
                    displayName: '预言家',
                    displayIcon: '👁️'
                  });
                }
                
                if (aliveWitches.length > 0) {
                  const witchDone = aliveWitches.some(w => gameState?.actionDone[w.id]) || gameState?.witchActionComplete;
                  teams.push({
                    role: 'witch',
                    done: witchDone,
                    displayName: '女巫',
                    displayIcon: '🧙‍♀️'
                  });
                }
                
                return teams.map(team => {
                  const showRole = isWolf || team.role === myRole;
                  return (
                    <div 
                      key={team.role}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-xs backdrop-blur-sm ${
                        team.done 
                          ? 'bg-gradient-to-r from-green-500/20 to-emerald-500/10 text-green-400 border border-green-500/20' 
                          : 'bg-wolf-purple/5 text-wolf-text/50 border border-wolf-purple/15'
                      }`}
                    >
                      {team.done ? (
                        <CheckCircle2 className="w-3 h-3" />
                      ) : (
                        <Circle className="w-3 h-3" />
                      )}
                      <span>{showRole ? team.displayIcon : '👤'}</span>
                      <span>{showRole ? team.displayName : '隐藏'}</span>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}

        {roleInfo && (
          <div className="mb-4 p-3 rounded-xl bg-gradient-to-br from-wolf-purple/5 to-wolf-purple-light/3 border border-wolf-purple/15">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xl">{roleInfo.icon}</span>
              <span className="font-medium text-wolf-text">{roleInfo.name}</span>
            </div>
            <p className="text-sm text-wolf-text/60">{roleInfo.description}</p>
            
            {/* 女巫药剂状态 */}
            {myRole === 'witch' && (
              <div className="flex gap-3 mt-3">
                <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg ${
                  witchHasHealPotion 
                    ? 'bg-green-500/20 border border-green-500/30 text-green-400' 
                    : 'bg-gray-500/20 border border-gray-500/30 text-gray-500'
                }`}>
                  <Heart className="w-4 h-4" />
                  <span className="text-sm font-medium">{witchHasHealPotion ? '解药 x1' : '解药 x0'}</span>
                </div>
                <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg ${
                  witchHasPoisonPotion 
                    ? 'bg-purple-500/20 border border-purple-500/30 text-purple-400' 
                    : 'bg-gray-500/20 border border-gray-500/30 text-gray-500'
                }`}>
                  <Skull className="w-4 h-4" />
                  <span className="text-sm font-medium">{witchHasPoisonPotion ? '毒药 x1' : '毒药 x0'}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {hasAction ? (
          <div className="text-center py-6">
            <div className="relative inline-block mb-3">
              <div className="absolute inset-0 bg-green-500/30 rounded-full blur-xl" />
              <div className="relative w-14 h-14 bg-gradient-to-br from-green-500/20 to-emerald-500/10 rounded-full flex items-center justify-center border border-green-500/20">
                <span className="text-2xl">✅</span>
              </div>
            </div>
            <p className="text-wolf-text font-medium">你的行动已完成</p>
            <p className="text-sm text-wolf-text/50 mt-1">等待其他玩家行动...</p>
          </div>
        ) : isWitchWaiting ? (
          <div className="text-center py-6">
            <div className="relative inline-block mb-3">
              <div className="absolute inset-0 bg-red-500/30 rounded-full blur-xl animate-pulse" />
              <div className="relative w-14 h-14 bg-gradient-to-br from-red-500/20 to-rose-500/10 rounded-full flex items-center justify-center border border-red-500/20">
                <span className="text-2xl">🐺</span>
              </div>
            </div>
            <p className="text-wolf-text font-medium">等待狼人行动</p>
            <p className="text-sm text-wolf-text/50 mt-1">狼人正在讨论击杀目标...</p>
          </div>
        ) : myRole === 'witch' && wolfKillComplete ? (
          <>
            {wolfKillTarget ? (
              <div className="mb-4 p-3 rounded-xl bg-gradient-to-r from-red-500/10 to-rose-500/5 border border-red-500/20">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xl">💀</span>
                  <span className="font-medium text-red-400">狼人击杀目标</span>
                </div>
                <p className="text-wolf-text">
                  狼人选择了 <span className="font-bold text-red-400">{players.find(p => p.id === wolfKillTarget)?.name || '未知'}</span> 作为击杀目标
                </p>
                <p className="text-sm text-wolf-text/50 mt-1">你可以使用解药救他，或者使用毒药</p>
              </div>
            ) : (
              <div className="mb-4 p-3 rounded-xl bg-gradient-to-r from-green-500/10 to-emerald-500/5 border border-green-500/20">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xl">🌟</span>
                  <span className="font-medium text-green-400">平安夜</span>
                </div>
                <p className="text-wolf-text">
                  狼人决定今晚不杀人
                </p>
                <p className="text-sm text-wolf-text/50 mt-1">你可以选择使用毒药或者跳过</p>
              </div>
            )}

            {witchHasHealPotion && wolfKillTarget && (
              <div className="mb-4">
                <p className="text-sm text-wolf-text/50 mb-2">选择是否使用解药:</p>
                <button
                  onClick={() => onAction('heal', wolfKillTarget)}
                  className="w-full px-4 py-3 rounded-xl border border-green-500/30 bg-gradient-to-r from-green-500/10 to-emerald-500/5 flex items-center justify-center gap-2 transition-all hover:from-green-500/20 hover:to-emerald-500/10 text-green-400"
                >
                  <Heart className="w-5 h-5" />
                  <span>使用解药救 {players.find(p => p.id === wolfKillTarget)?.name}</span>
                </button>
              </div>
            )}

            {witchHasPoisonPotion && (
              <div className="mb-4">
                <p className="text-sm text-wolf-text/50 mb-2">选择使用毒药毒杀（可选）:</p>
                <div className="space-y-2 max-h-[200px] overflow-y-auto">
                  {alivePlayers.map((player) => (
                    <PlayerCard
                      key={player.id}
                      player={player}
                      showRole={isWolf && player.role === 'wolf'}
                      isKillTarget={wolfKillTarget === player.id}
                      onSelect={(targetId) => {
                        onAction('poison', targetId);
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={onSkip}
                className="px-4 py-3 rounded-xl bg-wolf-purple/5 hover:bg-wolf-purple/10 text-wolf-text/70 hover:text-wolf-text font-medium transition-all border border-wolf-purple/15"
              >
                跳过（不使用任何药剂）
              </button>
              <button
                onClick={() => {
                  // 直接确认，不执行任何行动（如果已经执行了解药或毒药，actionDone会被设置）
                  // 这里的确定按钮是让女巫确认不使用任何额外药剂
                  const witchPlayer = players.find(p => p.id === currentUser?.id);
                  if (witchPlayer && !gameState?.actionDone[witchPlayer.id]) {
                    onSkip();
                  }
                }}
                className="px-4 py-3 rounded-xl bg-gradient-to-r from-wolf-purple/30 to-wolf-purple-light/20 border border-wolf-purple/30 text-wolf-purple-light hover:from-wolf-purple/40 hover:to-wolf-purple-light/30 font-medium transition-all"
              >
                确定
              </button>
            </div>
          </>
        ) : hasNightAction && actions.length > 0 ? (
          <>
            <div className="mb-4">
              <p className="text-sm text-wolf-text/50 mb-2">选择行动:</p>
              <div className="flex flex-wrap gap-2">
                {actions.map(({ action, label, icon: Icon, color, bg }) => (
                  <button
                    key={action}
                    onClick={() => {
                      if (alivePlayers.length === 1) {
                        onAction(action, alivePlayers[0].id);
                      }
                    }}
                    className={`w-full px-4 py-3 rounded-xl border border-wolf-purple/20 bg-gradient-to-r ${bg} flex items-center justify-center gap-2 transition-all hover:scale-105 ${color}`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>

            {alivePlayers.length > 0 && (
              <>
                <p className="text-sm text-wolf-text/50 mb-2">选择目标:</p>
                <div className="space-y-2 max-h-[280px] overflow-y-auto">
                  {alivePlayers.map((player) => (
                    <PlayerCard
                      key={player.id}
                      player={player}
                      showRole={isWolf && player.role === 'wolf'}
                      onSelect={(targetId) => {
                        if (actions.length === 1) {
                          onAction(actions[0].action, targetId);
                        }
                      }}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        ) : hasNightAction && actions.length === 0 ? (
          <div className="text-center py-6">
            <div className="w-14 h-14 bg-gradient-to-br from-gray-500/20 to-gray-600/10 rounded-full flex items-center justify-center mx-auto mb-3 border border-gray-500/20">
              <span className="text-2xl">🌙</span>
            </div>
            <p className="text-wolf-text font-medium">你的角色夜晚无需行动</p>
            <button
              onClick={onSkip}
              className="mt-4 btn-primary"
            >
              跳过
            </button>
          </div>
        ) : (
          <div className="text-center py-6">
            <div className="w-14 h-14 bg-gradient-to-br from-gray-500/20 to-gray-600/10 rounded-full flex items-center justify-center mx-auto mb-3 border border-gray-500/20">
              <span className="text-2xl">🌙</span>
            </div>
            <p className="text-wolf-text font-medium">等待其他玩家行动...</p>
            <button
              onClick={onSkip}
              className="mt-4 btn-primary"
            >
              跳过
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
