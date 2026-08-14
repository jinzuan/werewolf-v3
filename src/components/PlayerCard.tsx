﻿import { Crown, Bot, Skull, User, Circle, CheckCircle2 } from 'lucide-react';
import type { Player, Role } from '../types';
import { getRoleInfo, ROLE_COLORS } from '../utils/roleConfig';

interface PlayerCardProps {
  player: Player;
  showRole?: boolean;
  isCurrentTurn?: boolean;
  isSelected?: boolean;
  isKillTarget?: boolean;
  isSaveTarget?: boolean;
  onSelect?: (playerId: string) => void;
  small?: boolean;
  showStatus?: boolean;
}

export const PlayerCard = ({
  player,
  showRole = false,
  isCurrentTurn = false,
  isSelected = false,
  isKillTarget = false,
  isSaveTarget = false,
  onSelect,
  small = false,
  showStatus = true,
}: PlayerCardProps) => {
  const roleInfo = player.role ? getRoleInfo(player.role) : null;
  const isDead = !player.isAlive;
  const canInteract = !isDead && onSelect;

  /* ---- 动态背景样式 ---- */
  const cardBg = (() => {
    if (isSelected) {
      return 'linear-gradient(135deg, rgba(139,92,246,0.22) 0%, rgba(139,92,246,0.08) 100%)';
    }
    if (isKillTarget) {
      return 'linear-gradient(135deg, rgba(239,68,68,0.18) 0%, rgba(239,68,68,0.06) 100%)';
    }
    if (isSaveTarget) {
      return 'linear-gradient(135deg, rgba(34,197,94,0.18) 0%, rgba(34,197,94,0.06) 100%)';
    }
    if (isDead) {
      return 'rgba(255,255,255,0.015)';
    }
    return 'rgba(255,255,255,0.04)';
  })();

  const borderColor = (() => {
    if (isSelected)  return 'rgba(139,92,246,0.5)';
    if (isKillTarget) return 'rgba(239,68,68,0.5)';
    if (isSaveTarget)  return 'rgba(34,197,94,0.5)';
    if (isDead)       return 'rgba(255,255,255,0.04)';
    return 'rgba(139,92,246,0.1)';
  })();

  return (
    <div
      onClick={() => canInteract && onSelect?.(player.id)}
      style={{
        background: cardBg,
        borderColor: borderColor,
        boxShadow: isSelected
          ? '0 0 20px rgba(139,92,246,0.18), inset 0 1px 0 rgba(255,255,255,0.06)'
          : isKillTarget
          ? '0 0 20px rgba(239,68,68,0.15), inset 0 1px 0 rgba(255,255,255,0.04)'
          : 'inset 0 1px 0 rgba(255,255,255,0.04)',
      }}
      className={`
        relative rounded-2xl border backdrop-blur-md transition-all duration-300
        ${small ? 'px-3 py-2.5' : 'px-4 py-3.5'}
        ${isDead ? 'opacity-45' : ''}
        ${canInteract ? 'cursor-pointer hover:brightness-110' : 'cursor-default'}
        ${isSelected || isKillTarget || isSaveTarget ? 'scale-[1.015]' : ''}
      `}
    >
      {/* 选中/击杀/拯救 光晕层 */}
      {(isSelected || isKillTarget || isSaveTarget) && (
        <div
          className="absolute inset-0 rounded-2xl pointer-events-none transition-opacity duration-500"
          style={{
            background:
              isSelected
                ? 'radial-gradient(circle at 30% 30%, rgba(139,92,246,0.14), transparent 65%)'
                : isKillTarget
                ? 'radial-gradient(circle at 30% 30%, rgba(239,68,68,0.14), transparent 65%)'
                : 'radial-gradient(circle at 30% 30%, rgba(34,197,94,0.14), transparent 65%)',
          }}
        />
      )}

      {/* 死亡标志 */}
      {isDead && (
        <div className="absolute top-2 right-2 pointer-events-none">
          <Skull className="w-4 h-4 text-gray-500/70" />
        </div>
      )}

      {/* 击杀目标脉冲指示器 */}
      {isKillTarget && !isDead && (
        <div className="absolute top-2 right-2 pointer-events-none">
          <div className="relative">
            <Skull className="w-4 h-4 text-red-400" />
            <div className="absolute -inset-1 rounded-full bg-red-400/20 animate-ping" />
          </div>
        </div>
      )}

      {/* 当前发言者标记 */}
      {isCurrentTurn && !isDead && (
        <div className="absolute -top-2.5 -right-2.5 z-20 pointer-events-none">
          <div className="relative">
            <div
              className="text-[10px] font-bold px-2.5 py-0.5 rounded-full text-black"
              style={{
                background: 'linear-gradient(135deg, #FACC15, #F97316)',
                boxShadow: '0 0 12px rgba(250,204,21,0.35)',
              }}
            >
              发言中
            </div>
            <div className="absolute -inset-1 rounded-full bg-yellow-400/15 animate-pulse" />
          </div>
        </div>
      )}

      {/* ====== 主体内容 ====== */}
      <div className={`relative z-10 flex items-center ${small ? 'gap-2' : 'gap-3'}`}>

        {/* 头像圆 */}
        <div
          className={`
            relative rounded-full flex items-center justify-center flex-shrink-0
            ${small ? 'w-9 h-9' : 'w-11 h-11'}
            transition-transform duration-300
            ${canInteract ? 'hover:scale-110' : ''}
          `}
          style={{
            background:
              player.isAI
                ? 'linear-gradient(135deg, rgba(59,130,246,0.35), rgba(37,99,235,0.18))'
                : isDead
                ? 'rgba(107,114,128,0.15)'
                : 'linear-gradient(135deg, rgba(139,92,246,0.35), rgba(168,85,247,0.18))',
            border:
              player.isAI
                ? '1px solid rgba(59,130,246,0.3)'
                : isDead
                ? '1px solid rgba(107,114,128,0.2)'
                : '1px solid rgba(139,92,246,0.3)',
          }}
        >
          {/* 内发光 */}
          <div className="absolute inset-0 rounded-full bg-gradient-to-br from-white/8 to-transparent pointer-events-none" />

          {player.isAI ? (
            <Bot className={`relative z-10 text-blue-400 ${small ? 'w-4 h-4' : 'w-5 h-5'}`} />
          ) : (
            <User className={`relative z-10 ${small ? 'w-4 h-4' : 'w-5 h-5'} ${isDead ? 'text-gray-500' : 'text-purple-200'}`} />
          )}

          {/* 在线脉冲点 */}
          {!player.isAI && !isDead && (
            <div
              className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-[#0F0A1E] animate-pulse"
              style={{ background: 'rgba(74,222,128,0.9)' }}
            />
          )}

          {/* 当前发言者脉冲环 */}
          {isCurrentTurn && !isDead && (
            <div className="absolute -inset-1 rounded-full border border-yellow-400/40 animate-ping pointer-events-none" />
          )}
        </div>

        {/* 文字区 */}
        <div className="flex-1 min-w-0">

          {/* 名字 + 标签行 */}
          <div className="flex items-center gap-1.5 truncate">
            <span
              className={`
                font-semibold truncate
                ${small ? 'text-sm' : 'text-[15px]'}
                ${isDead ? 'text-gray-400' : 'text-purple-100'}
                transition-colors duration-300
              `}
            >
              {player.name}
            </span>

            {player.isHost && (
              <Crown className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0 drop-shadow-[0_0_6px_rgba(250,204,21,0.45)]" />
            )}

            {player.isAI && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/12 text-blue-400/80 flex-shrink-0">
                AI
              </span>
            )}
          </div>

          {/* 角色信息 */}
          {showStatus && showRole && roleInfo && !isDead && (
            <div className={`flex items-center gap-1.5 mt-1 ${small ? 'mt-0.5' : ''}`}>
              <span className={`${small ? 'text-sm' : 'text-base'} animate-float-gentle origin-[center_bottom]`}>
                {roleInfo.icon}
              </span>
              <span className={`text-xs font-medium ${ROLE_COLORS[player.role as Role]}`}>
                {roleInfo.name}
              </span>
            </div>
          )}

          {/* 状态指示 */}
          {showStatus && !showRole && !isDead && (
            <div className="flex items-center gap-1.5 mt-1">
              <div
                className="w-1.5 h-1.5 rounded-full animate-pulse"
                style={{
                  background: player.isAI ? 'rgba(96,165,250,0.8)' : 'rgba(74,222,128,0.8)',
                }}
              />
              <span className="text-[11px] text-purple-200/50">
                {player.isAI ? 'AI 玩家' : '在线'}
              </span>
            </div>
          )}

          {isDead && (
            <div className="flex items-center gap-1.5 mt-1">
              <Skull className="w-3 h-3 text-gray-500/60" />
              <span className="text-[11px] text-gray-500/60">已出局</span>
            </div>
          )}
        </div>

        {/* 选中勾 */}
        {isSelected && !isDead && (
          <div className="flex-shrink-0 pointer-events-none">
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center"
              style={{ background: 'rgba(139,92,246,0.25)' }}
            >
              <CheckCircle2 className="w-4 h-4 text-purple-300" />
            </div>
          </div>
        )}
      </div>

      {/* 四角选中装饰线 */}
      {isSelected && !isDead && (
        <>
          <div className="absolute top-1.5 left-1.5 w-3 h-3 pointer-events-none">
            <div className="absolute top-0 left-0 w-full h-[1.5px] rounded-full bg-purple-400/40" />
            <div className="absolute top-0 left-0 w-[1.5px] h-full rounded-full bg-purple-400/40" />
          </div>
          <div className="absolute top-1.5 right-1.5 w-3 h-3 pointer-events-none">
            <div className="absolute top-0 right-0 w-full h-[1.5px] rounded-full bg-purple-400/40" />
            <div className="absolute top-0 right-0 w-[1.5px] h-full rounded-full bg-purple-400/40" />
          </div>
          <div className="absolute bottom-1.5 left-1.5 w-3 h-3 pointer-events-none">
            <div className="absolute bottom-0 left-0 w-full h-[1.5px] rounded-full bg-purple-400/40" />
            <div className="absolute bottom-0 left-0 w-[1.5px] h-full rounded-full bg-purple-400/40" />
          </div>
          <div className="absolute bottom-1.5 right-1.5 w-3 h-3 pointer-events-none">
            <div className="absolute bottom-0 right-0 w-full h-[1.5px] rounded-full bg-purple-400/40" />
            <div className="absolute bottom-0 right-0 w-[1.5px] h-full rounded-full bg-purple-400/40" />
          </div>
        </>
      )}
    </div>
  );
};
