import { useGameStore } from '../stores/gameStore';
import { getRoleInfo } from '../utils/roleConfig';
import { Clock, Moon, Sun, Vote, Users, CheckCircle2, Circle } from 'lucide-react';

export const GameProgressPanel = () => {
  const { gameState, players, myRole, currentUser, wolfKillComplete } = useGameStore();

  const getPhaseIcon = () => {
    switch (gameState?.phase) {
      case 'night':
        return <Moon className="w-5 h-5 text-indigo-400" />;
      case 'day':
        return <Sun className="w-5 h-5 text-yellow-400" />;
      case 'vote':
        return <Vote className="w-5 h-5 text-orange-400" />;
      case 'roleSelect':
        return <Users className="w-5 h-5 text-blue-400" />;
      default:
        return <Circle className="w-5 h-5 text-gray-400" />;
    }
  };

  const getPhaseBg = () => {
    switch (gameState?.phase) {
      case 'night':
        return 'from-indigo-500/30 to-purple-500/20';
      case 'day':
        return 'from-yellow-500/30 to-orange-500/20';
      case 'vote':
        return 'from-orange-500/30 to-red-500/20';
      case 'roleSelect':
        return 'from-blue-500/30 to-indigo-500/20';
      default:
        return 'from-gray-500/20 to-gray-600/10';
    }
  };

  const getCurrentAction = () => {
    if (!gameState) return null;
    
    switch (gameState.phase) {
      case 'night': {
        const actingRoles: { role: string; name: string; icon: string }[] = [];
        const shouldActPlayers = players.filter(p => 
          p.isAlive && (p.role === 'wolf' || p.role === 'seer' || p.role === 'witch' || p.role === 'guardian')
        );
        
        const roleCounts: Record<string, number> = {};
        shouldActPlayers.forEach(p => {
          if (p.role && !gameState.actionDone[p.id]) {
            roleCounts[p.role] = (roleCounts[p.role] || 0) + 1;
          }
        });
        
        Object.entries(roleCounts).forEach(([role, count]) => {
          const isVisible = myRole === 'wolf' || (myRole === role && players.find(p => p.id === currentUser?.id)?.role === role);
          const roleInfo = isVisible ? getRoleInfo(role as any) : null;
          const displayName = isVisible && roleInfo ? roleInfo.name : '隐藏';
          const displayIcon = isVisible && roleInfo ? roleInfo.icon : '👤';
          
          if (count > 1) {
            actingRoles.push({ role, name: `${displayName} x${count}`, icon: displayIcon });
          } else {
            actingRoles.push({ role, name: displayName, icon: displayIcon });
          }
        });
        
        if (actingRoles.length > 0) {
          return {
            title: '正在行动',
            items: actingRoles.slice(0, 3),
            next: '等待行动完成',
          };
        }
        return {
          title: '行动完成',
          items: [],
          next: '即将进入白天',
        };
      }
      case 'day': {
        const currentSpeaker = players.find(p => p.id === gameState.currentSpeaker);
        const speakerName = currentSpeaker?.name || '未知';
        return {
          title: '发言中',
          items: [{ role: '', name: speakerName, icon: '🎤' }],
          next: '下一位发言者',
        };
      }
      case 'vote':
        return {
          title: '投票阶段',
          items: [],
          next: '等待投票完成',
        };
      case 'roleSelect':
        return {
          title: '角色选择',
          items: [],
          next: '确认角色后开始游戏',
        };
      default:
        return null;
    }
  };

  const getNextAction = () => {
    if (!gameState) return null;
    
    switch (gameState.phase) {
      case 'night': {
        const nightRoles = ['wolf', 'seer', 'witch', 'guardian'];
        const remainingRoles = nightRoles.filter(role => {
          const playerWithRole = players.find(p => p.isAlive && p.role === role);
          return playerWithRole && !gameState.actionDone[playerWithRole.id];
        });
        
        if (remainingRoles.length > 0) {
          const isVisible = myRole === 'wolf';
          const nextRole = getRoleInfo(remainingRoles[0] as any);
          return isVisible ? `${nextRole.icon} ${nextRole.name}即将行动` : '有人即将行动';
        }
        return '☀️ 天亮了';
      }
      case 'day': {
        const currentIndex = gameState.speakerOrder.indexOf(gameState.currentSpeaker || '');
        const nextIndex = (currentIndex + 1) % gameState.speakerOrder.length;
        const nextSpeaker = players.find(p => p.id === gameState.speakerOrder[nextIndex]);
        return nextSpeaker ? `下一位: ${nextSpeaker.name}` : '发言结束';
      }
      case 'vote':
        return '📊 统计投票结果';
      case 'roleSelect':
        return '🌙 进入夜晚';
      default:
        return null;
    }
  };

  const currentAction = getCurrentAction();
  const nextAction = getNextAction();

  const getActionProgress = () => {
    if (!gameState || gameState.phase !== 'night') return null;
    
    const aliveWolves = players.filter(p => p.isAlive && p.role === 'wolf');
    const aliveSeers = players.filter(p => p.isAlive && p.role === 'seer');
    const aliveWitches = players.filter(p => p.isAlive && p.role === 'witch');
    const aliveGuardians = players.filter(p => p.isAlive && p.role === 'guardian');
    
    let totalCount = 0;
    let actedCount = 0;
    
    // 统计存活角色的行动
    if (aliveWolves.length > 0) {
      totalCount++;
      if (gameState.actionDone['wolf_team'] || wolfKillComplete) {
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
    if (aliveGuardians.length > 0) {
      totalCount++;
      const guardianActed = aliveGuardians.some(g => gameState.actionDone[g.id]) || gameState.guardianActionComplete;
      if (guardianActed) {
        actedCount++;
      }
    }
    
    // 为了避免玩家通过行动进度推测是否有神职死亡，添加虚拟进度
    // 随机生成一个虚拟的额外进度（0或1），模拟死亡神职的"虚拟行动"
    // 只有当实际进度小于最大可能进度时，才添加虚拟进度
    const maxPossibleProgress = 4; // 狼人、预言家、女巫、守卫
    const currentProgress = actedCount / totalCount;
    
    // 如果当前进度已经较高，不再添加虚拟进度
    if (currentProgress >= 0.75) {
      return { actedCount, totalCount };
    }
    
    // 30%概率添加虚拟进度
    const hasVirtualProgress = Math.random() > 0.7;
    
    // 添加虚拟进度后，总进度会增加
    const virtualTotalCount = hasVirtualProgress ? totalCount + 1 : totalCount;
    const virtualActedCount = hasVirtualProgress ? actedCount + 1 : actedCount;
    
    return { 
      actedCount: virtualActedCount, 
      totalCount: virtualTotalCount,
      isVirtual: hasVirtualProgress
    };
  };

  const progress = getActionProgress();

  return (
    <div className="card-glass overflow-hidden">
      <div className="px-4 py-3 border-b border-white/5 glass-highlight">
        <div className="flex items-center gap-2">
          <div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${getPhaseBg()} flex items-center justify-center`}>
            {getPhaseIcon()}
          </div>
          <h3 className="font-semibold text-wolf-text">游戏阶段</h3>
        </div>
      </div>

      <div className="p-4">
        {gameState && (
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm text-wolf-text/50">当前阶段</p>
              <p className="text-lg font-bold text-wolf-text">
                {gameState.phase === 'night' && '🌙 夜晚'}
                {gameState.phase === 'day' && '☀️ 白天'}
                {gameState.phase === 'vote' && '🗳️ 投票'}
                {gameState.phase === 'roleSelect' && '🎴 角色选择'}
                {gameState.phase === 'waiting' && '⏳ 等待开始'}
                {gameState.phase === 'ended' && '🏁 游戏结束'}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm text-wolf-text/50">第 {gameState.day} 天</p>
              <div className="flex items-center gap-1 text-wolf-purple-light">
                <Clock className="w-4 h-4" />
                <span className="font-bold">
                  {gameState.phase === 'day' ? gameState.speechTimeLeft : gameState.actionTimeLeft}s
                </span>
              </div>
            </div>
          </div>
        )}

        {currentAction && currentAction.items.length > 0 && (
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-medium text-wolf-text/70">{currentAction.title}</span>
            </div>
            
            <div className="space-y-2">
              {currentAction.items.map((item, index) => (
                <div key={index} className="flex items-center gap-2 text-sm p-2 rounded-lg bg-white/[0.02]">
                  <span>{item.icon}</span>
                  <span className="text-wolf-text">{item.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {nextAction && (
          <div className="p-3 rounded-xl bg-gradient-to-r from-wolf-purple/10 to-wolf-purple-light/5 border border-white/5">
            <div className="flex items-center gap-2">
              <span className="text-xs text-wolf-text/40">下一步</span>
              <span className="text-sm text-wolf-text font-medium">{nextAction}</span>
            </div>
          </div>
        )}

        {progress && gameState?.phase === 'night' && (
          <div className="mt-4">
            <div className="flex items-center justify-between text-sm mb-1">
              <span className="text-wolf-text/50">行动进度</span>
              <span className="text-wolf-text font-medium">{progress.actedCount}/{progress.totalCount}</span>
            </div>
            <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-wolf-purple to-wolf-purple-light transition-all duration-500 rounded-full"
                style={{ width: `${(progress.actedCount / progress.totalCount) * 100}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
