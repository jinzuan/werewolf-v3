import { useState, useCallback } from 'react';
import { Moon, Target, Eye, Heart, Skull, CheckCircle2, Circle, Check } from 'lucide-react';
import { useGameStore } from '../stores/gameStore';
import { PlayerCard } from './PlayerCard';
import { getRoleInfo } from '../utils/roleConfig';
import { Modal } from './Modal';
import type { Role } from '../types';

interface NightActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAction: (action: 'kill' | 'check' | 'heal' | 'poison' | 'guard', targetId: string) => void;
  onSkip: () => void;
}

export const NightActionModal = ({
  isOpen,
  onClose,
  onAction,
  onSkip,
}: NightActionModalProps) => {
  const { players, myRole, currentUser, gameState, wolfKillComplete, wolfKillTarget } = useGameStore();
  const alivePlayers = players.filter((p) => p.isAlive && p.id !== currentUser?.id);

  const availablePlayers = myRole === 'guardian'
    ? alivePlayers.filter((p) => p.id !== gameState?.guardianLastTarget)
    : alivePlayers;

  const [selectedAction, setSelectedAction] = useState<'kill' | 'check' | 'heal' | 'poison' | 'guard' | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);

  const myPlayer =
    players.find((p) => p.id === currentUser?.id) ??
    players.find((p) => p.name === currentUser?.name) ??
    players.find((p) => p.isHost);

  const hasActed = myPlayer ? gameState?.actionDone[myPlayer.id] : false;
  const isWitchWaiting = myRole === 'witch' && !wolfKillComplete;
  // v2.3 任务 C4：女巫不知道守卫是否守护——解药可用且有人被袭击即可选择救人（同守同救致死由引擎结算）
  // N6：解药已用完时，不再提示被刀者是谁、也不再提供救人
  const healAvailable = (gameState?.witchHasHealPotion ?? true) && !!wolfKillTarget;

  /* ---- 可用行动列表 ---- */
  const getAvailableActions = useCallback((role: Role) => {
    switch (role) {
      case 'wolf':
        return [{ action: 'kill' as const, label: '击杀', icon: Target, color: 'text-red-400', bg: 'rgba(239,68,68,0.15)' }];
      case 'seer':
        return [{ action: 'check' as const, label: '查验', icon: Eye, color: 'text-blue-400', bg: 'rgba(59,130,246,0.15)' }];
      case 'witch':
        return [
          { action: 'heal' as const, label: '使用解药', icon: Heart, color: 'text-green-400', bg: 'rgba(34,197,94,0.15)' },
          { action: 'poison' as const, label: '使用毒药', icon: Skull, color: 'text-purple-300', bg: 'rgba(168,85,247,0.15)' },
        ];
      case 'guardian':
        return [{ action: 'guard' as const, label: '守护', icon: Target, color: 'text-yellow-400', bg: 'rgba(234,179,8,0.12)' }];
      default:
        return [];
    }
  }, []);

  const actions = myRole ? getAvailableActions(myRole) : [];

  /* ---- 行动进度 ---- */
  const getActionProgress = useCallback(() => {
    if (!gameState || gameState.phase !== 'night') return null;
    let total = 0, acted = 0;

    const wolves = players.filter((p) => p.isAlive && p.role === 'wolf');
    if (wolves.length > 0) { total++; if (gameState.actionDone['wolf_team'] || wolfKillComplete) acted++; }

    const guardians = players.filter((p) => p.isAlive && p.role === 'guardian');
    if (guardians.length > 0) { total++; if (guardians.some((g) => gameState.actionDone[g.id]) || gameState?.guardianActionComplete) acted++; }

    const seers = players.filter((p) => p.isAlive && p.role === 'seer');
    if (seers.length > 0) { total++; if (seers.some((s) => gameState.actionDone[s.id])) acted++; }

    const witches = players.filter((p) => p.isAlive && p.role === 'witch');
    if (witches.length > 0) { total++; if (witches.some((w) => gameState.actionDone[w.id])) acted++; }

    return { acted, total };
  }, [players, gameState, wolfKillComplete]);

  const progress = getActionProgress();
  const isWolf = myRole === 'wolf';

  /* ---- 交互 ---- */
  const handleSelectAction = (action: 'kill' | 'check' | 'heal' | 'poison' | 'guard') => {
    setSelectedAction(action);
    if (actions.length === 1 && alivePlayers.length > 0) {
      setSelectedTarget(alivePlayers[0].id);
    }
  };

  const handleSelectTarget = (targetId: string) => {
    if (!selectedAction) {
      if (myRole === 'witch' && targetId === wolfKillTarget && wolfKillTarget && healAvailable) {
        setSelectedAction('heal');
      } else if (myRole === 'witch') {
        setSelectedAction('poison');
      } else if (actions.length === 1) {
        setSelectedAction(actions[0].action);
      }
    }
    setSelectedTarget(targetId);
  };

  const handleConfirm = () => {
    if (selectedAction && selectedTarget) {
      onAction(selectedAction, selectedTarget);
      onClose();
    } else {
      onSkip();
      onClose();
    }
  };

  const handleSkip = () => { onSkip(); onClose(); };
  const canConfirm = selectedAction && selectedTarget;

  /* ========== 渲染 ========== */
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="夜晚行动" size="xl">
      {/* 标题区 */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(99,102,241,0.18)', border: '1px solid rgba(99,102,241,0.2)' }}>
          <Moon className="w-5 h-5 text-indigo-300" />
        </div>
        <div>
          <p className="text-purple-100 font-medium text-sm">夜晚行动时间</p>
          <p className="text-[11px] text-purple-200/35 mt-0.5">执行你的夜间技能</p>
        </div>
      </div>

      {/* 行动进度条 */}
      {progress && progress.total > 0 && (
        <div className="mb-5 p-3.5 rounded-xl border" style={{ background: 'rgba(255,255,255,0.01)', borderColor: 'rgba(255,255,255,0.04)' }}>
          <div className="flex items-center justify-between text-[11px] mb-2">
            <span className="text-purple-200/40">行动进度</span>
            <span className="text-purple-200/60 font-medium">{progress.acted}/{progress.total}</span>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)' }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${progress.total ? (progress.acted / progress.total) * 100 : 0}%`,
                background: 'linear-gradient(90deg, #8B5CF6, #A855F7)',
              }}
            />
          </div>

          {/* 各阵营行动状态 */}
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {(() => {
              const badges: { role: string; done: boolean; icon: string; label: string }[] = [];

              const wolves = players.filter((p) => p.isAlive && p.role === 'wolf');
              if (wolves.length > 0) {
                badges.push({
                  role: 'wolf',
                  done: gameState?.actionDone['wolf_team'] || wolfKillComplete,
                  icon: isWolf ? '🐺' : '👤',
                  label: isWolf ? '狼人' : '隐藏',
                });
              }

              const guardians = players.filter((p) => p.isAlive && p.role === 'guardian');
              if (guardians.length > 0) {
                badges.push({
                  role: 'guardian',
                  done: guardians.some((g) => gameState?.actionDone[g.id]) || gameState?.guardianActionComplete,
                  icon: myRole === 'guardian' ? '🛡️' : '👤',
                  label: myRole === 'guardian' ? '守卫' : '隐藏',
                });
              }

              const seers = players.filter((p) => p.isAlive && p.role === 'seer');
              if (seers.length > 0) {
                badges.push({
                  role: 'seer',
                  done: seers.some((s) => gameState?.actionDone[s.id]),
                  icon: myRole === 'seer' ? '👁️' : '👤',
                  label: myRole === 'seer' ? '预言家' : '隐藏',
                });
              }

              const witches = players.filter((p) => p.isAlive && p.role === 'witch');
              if (witches.length > 0) {
                badges.push({
                  role: 'witch',
                  done: witches.some((w) => gameState?.actionDone[w.id]),
                  icon: myRole === 'witch' ? '🧙‍♀️' : '👤',
                  label: myRole === 'witch' ? '女巫' : '隐藏',
                });
              }

              return badges.map((b) => (
                <div
                  key={b.role}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] border ${
                    b.done ? 'border-green-500/20' : 'border-white/5'
                  }`}
                  style={b.done ? { background: 'rgba(34,197,94,0.08)' } : { background: 'rgba(255,255,255,0.01)' }}
                >
                  {b.done
                    ? <CheckCircle2 className="w-2.5 h-2.5 text-green-400" />
                    : <Circle className="w-2.5 h-2.5 text-purple-200/20" />
                  }
                  <span className={b.done ? 'text-green-400/80' : 'text-purple-200/30'}>{b.icon} {b.label}</span>
                </div>
              ));
            })()}
          </div>
        </div>
      )}

      {/* 我的角色信息 */}
      {myRole && (
        <div className="mb-5 p-3.5 rounded-xl border" style={{ background: 'rgba(255,255,255,0.015)', borderColor: 'rgba(255,255,255,0.04)' }}>
          <div className="flex items-center gap-2.5 mb-1">
            <span className="text-xl">{getRoleInfo(myRole).icon}</span>
            <div>
              <span className="text-purple-100 font-medium text-sm">{getRoleInfo(myRole).name}</span>
              <p className="text-[11px] text-purple-200/30 leading-relaxed">{getRoleInfo(myRole).description}</p>
            </div>
          </div>

          {/* 女巫药剂状态 */}
          {myRole === 'witch' && (
            <div className="flex gap-2.5 mt-2.5">
              <div
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border"
                style={
                  (gameState?.witchHasHealPotion ?? true)
                    ? { background: 'rgba(34,197,94,0.1)', borderColor: 'rgba(34,197,94,0.2)', color: 'rgba(74,222,128,0.9)' }
                    : { background: 'rgba(107,114,128,0.08)', borderColor: 'rgba(107,114,128,0.12)', color: 'rgba(156,163,175,0.5)' }
                }
              >
                <Heart className="w-3.5 h-3.5" />
                <span>解药 x{(gameState?.witchHasHealPotion ?? true) ? 1 : 0}</span>
              </div>
              <div
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border"
                style={
                  (gameState?.witchHasPoisonPotion ?? true)
                    ? { background: 'rgba(168,85,247,0.1)', borderColor: 'rgba(168,85,247,0.2)', color: 'rgba(192,132,252,0.9)' }
                    : { background: 'rgba(107,114,128,0.08)', borderColor: 'rgba(107,114,128,0.12)', color: 'rgba(156,163,175,0.5)' }
                }
              >
                <Skull className="w-3.5 h-3.5" />
                <span>毒药 x{(gameState?.witchHasPoisonPotion ?? true) ? 1 : 0}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== 已行动 ===== */}
      {hasActed ? (
        <div className="text-center py-8 animate-fade-in">
          <div className="relative inline-block mb-4">
            <div className="absolute inset-0 rounded-full blur-xl" style={{ background: 'rgba(34,197,94,0.2)' }} />
            <div className="relative w-16 h-16 rounded-full flex items-center justify-center text-2xl border" style={{ background: 'rgba(34,197,94,0.08)', borderColor: 'rgba(34,197,94,0.15)' }}>
              ✅
            </div>
          </div>
          <p className="text-purple-100 font-medium">你的行动已完成</p>
          <p className="text-[11px] text-purple-200/30 mt-1">等待其他玩家行动...</p>
          <button onClick={onClose} className="mt-4 btn-secondary text-sm py-2 px-5">关闭</button>
        </div>
      ) : isWitchWaiting ? (
        /* ===== 女巫等待狼人 ===== */
        <div className="text-center py-8 animate-fade-in">
          <div className="relative inline-block mb-4">
            <div className="absolute inset-0 rounded-full blur-xl animate-pulse" style={{ background: 'rgba(239,68,68,0.2)' }} />
            <div className="relative w-16 h-16 rounded-full flex items-center justify-center text-2xl border" style={{ background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.15)' }}>
              🐺
            </div>
          </div>
          <p className="text-purple-100 font-medium">等待狼人行动</p>
          <p className="text-[11px] text-purple-200/30 mt-1">狼人正在讨论击杀目标...</p>
          <button onClick={onClose} className="mt-4 btn-secondary text-sm py-2 px-5">关闭</button>
        </div>
      ) : myRole === 'witch' && wolfKillComplete ? (
        /* ===== 女巫行动（狼人已击杀） ===== */
        <>
          {healAvailable ? (
            <div className="mb-5 p-3.5 rounded-xl border" style={{ background: 'rgba(239,68,68,0.06)', borderColor: 'rgba(239,68,68,0.12)' }}>
              <div className="flex items-center gap-2.5 mb-2">
                <span className="text-xl">💀</span>
                <div>
                  <p className="text-red-400 font-medium text-sm">狼人击杀目标</p>
                  <p className="text-[11px] text-purple-200/40 mt-0.5">
                    狼人选择了 <span className="text-red-400 font-semibold">{players.find((p) => p.id === wolfKillTarget)?.name || '未知'}</span>
                  </p>
                </div>
              </div>
              <p className="text-[11px] text-purple-200/30">你可以使用解药救他，或使用毒药</p>
            </div>
          ) : myRole === 'witch' && wolfKillTarget ? (
            <div className="mb-5 p-3.5 rounded-xl border" style={{ background: 'rgba(107,114,128,0.06)', borderColor: 'rgba(107,114,128,0.12)' }}>
              <div className="flex items-center gap-2.5 mb-2">
                <span className="text-xl">💊</span>
                <div>
                  <p className="text-yellow-400 font-medium text-sm">解药已用完</p>
                  <p className="text-[11px] text-purple-200/40 mt-0.5">你今晚只能选择使用毒药或者跳过</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="mb-5 p-3.5 rounded-xl border" style={{ background: 'rgba(34,197,94,0.06)', borderColor: 'rgba(34,197,94,0.12)' }}>
              <div className="flex items-center gap-2.5 mb-2">
                <span className="text-xl">🌙</span>
                <div>
                  <p className="text-green-400 font-medium text-sm">平安夜</p>
                  <p className="text-[11px] text-purple-200/40 mt-0.5">昨晚是平安夜，没有玩家死亡</p>
                </div>
              </div>
              <p className="text-[11px] text-purple-200/30">你可以选择使用毒药或者跳过（无法使用解药）</p>
            </div>
          )}

          {/* 解药按钮 */}
          {healAvailable && (
            <div className="mb-4">
              <p className="text-[11px] text-purple-200/35 mb-2">使用解药：</p>
              <button
                onClick={() => { setSelectedAction('heal'); setSelectedTarget(wolfKillTarget); }}
                className={`w-full px-4 py-2.5 rounded-xl border text-sm font-medium transition-all duration-300 flex items-center justify-center gap-2 ${
                  selectedAction === 'heal' && selectedTarget === wolfKillTarget
                    ? 'border-green-500/35'
                    : 'border-white/5 hover:border-green-500/20'
                }`}
                style={
                  selectedAction === 'heal' && selectedTarget === wolfKillTarget
                    ? { background: 'rgba(34,197,94,0.15)' }
                    : { background: 'rgba(34,197,94,0.05)' }
                }
              >
                <Heart className="w-4 h-4 text-green-400" />
                <span className="text-green-300">使用解药救 {players.find((p) => p.id === wolfKillTarget)?.name}</span>
              </button>
            </div>
          )}

          {/* 毒药目标选择 */}
          <div className="mb-4">
            <p className="text-[11px] text-purple-200/35 mb-2">
              {healAvailable ? '使用毒药毒杀：' : '选择使用毒药毒杀，或跳过：'}
            </p>
            <div className="space-y-2 max-h-72 overflow-y-auto pr-0.5">
              {alivePlayers.map((player) => (
                <PlayerCard
                  key={player.id}
                  player={player}
                  showRole={isWolf && player.role === 'wolf'}
                  isSelected={selectedAction === 'poison' && selectedTarget === player.id}
                  onSelect={(targetId) => handleSelectTarget(targetId)}
                />
              ))}
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="grid grid-cols-2 gap-3 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
            <button
              onClick={handleConfirm}
              disabled={!canConfirm}
              className="btn-primary text-sm py-2.5 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <Check className="w-4 h-4" /> 确定
            </button>
            <button onClick={handleSkip} className="btn-secondary text-sm py-2.5">
              跳过
            </button>
          </div>
        </>
      ) : actions.length > 0 ? (
        /* ===== 普通行动选择 ===== */
        <>
          {/* 守卫提示 */}
          {myRole === 'guardian' && gameState?.guardianLastTarget && (
            <div className="mb-4 p-3 rounded-xl border" style={{ background: 'rgba(234,179,8,0.05)', borderColor: 'rgba(234,179,8,0.12)' }}>
              <p className="text-yellow-400 font-medium text-xs">⚠️ 注意</p>
              <p className="text-[11px] text-purple-200/40 mt-0.5">你不能连续两晚守护同一个人</p>
              <p className="text-[11px] text-yellow-400/50 mt-0.5">
                上一晚守护了：<span className="font-medium">{players.find((p) => p.id === gameState.guardianLastTarget)?.name}</span>
              </p>
            </div>
          )}

          {/* 行动选择按钮 */}
          <div className="mb-4">
            <p className="text-[11px] text-purple-200/35 mb-2">选择行动：</p>
            <div className="grid grid-cols-2 gap-2.5">
              {actions.map(({ action, label, icon: Icon, color, bg }) => (
                <button
                  key={action}
                  onClick={() => handleSelectAction(action)}
                  className={`px-4 py-2.5 rounded-xl border text-sm font-medium transition-all duration-300 flex items-center justify-center gap-2 ${
                    selectedAction === action ? 'border-white/20' : 'border-white/5 hover:border-white/10'
                  }`}
                  style={selectedAction === action ? { background: bg } : { background: 'rgba(255,255,255,0.01)' }}
                >
                  <Icon className={`w-4 h-4 ${color}`} />
                  <span className="text-purple-200/70">{label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 目标选择 */}
          {availablePlayers.length > 0 && (
            <div className="mb-4">
              <p className="text-[11px] text-purple-200/35 mb-2">选择目标：</p>
              <div className="space-y-2 max-h-72 overflow-y-auto pr-0.5">
                {availablePlayers.map((player) => (
                  <PlayerCard
                    key={player.id}
                    player={player}
                    showRole={isWolf && player.role === 'wolf'}
                    isSelected={selectedTarget === player.id}
                    onSelect={(targetId) => handleSelectTarget(targetId)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* 守卫无目标提示 */}
          {myRole === 'guardian' && availablePlayers.length === 0 && (
            <div className="mb-4 p-3 rounded-xl border text-center" style={{ background: 'rgba(107,114,128,0.04)', borderColor: 'rgba(107,114,128,0.08)' }}>
              <p className="text-purple-200/40 text-sm">没有其他玩家可以守护</p>
              <p className="text-[11px] text-purple-200/25 mt-0.5">请选择跳过</p>
            </div>
          )}

          {/* 操作按钮 */}
          <div className="grid grid-cols-2 gap-3 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
            <button
              onClick={handleConfirm}
              disabled={!canConfirm}
              className="btn-primary text-sm py-2.5 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <Check className="w-4 h-4" /> 确定
            </button>
            <button onClick={handleSkip} className="btn-secondary text-sm py-2.5">
              跳过
            </button>
          </div>
        </>
      ) : (
        /* ===== 无行动（等待其他玩家） ===== */
        <div className="text-center py-8 animate-fade-in">
          <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 border" style={{ background: 'rgba(107,114,128,0.06)', borderColor: 'rgba(107,114,128,0.1)' }}>
            <span className="text-2xl">🌙</span>
          </div>
          <p className="text-purple-100 font-medium">等待其他玩家行动...</p>
          <button onClick={handleSkip} className="mt-4 btn-secondary text-sm py-2 px-5">跳过</button>
        </div>
      )}
    </Modal>
  );
};
