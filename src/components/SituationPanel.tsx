import { LayoutDashboard, Users, Skull, AlertTriangle } from 'lucide-react';
import { getPhaseText } from '../utils/gameLogic';
import type { GameState, Message, Player } from '../types';

/**
 * SituationPanel — v2.4.8 任务15：局势黑板（WebUI 可随时查看）。
 * 展示静态规则之外的本局动态局势：当前阶段 / 存活人数 / 已出局 / 每日局势摘要。
 * 只展示公开信息（存活/死亡/阶段），不泄露身份。
 */
export const SituationPanel = ({
  gameState,
  players,
  messages,
}: {
  gameState: GameState | null;
  players: Player[];
  messages: Message[];
}) => {
  if (!gameState) return null;
  const alive = players.filter((p) => p.isAlive);
  const dead = players.filter((p) => !p.isAlive);
  const latestSummary = [...messages]
    .reverse()
    .find((m) => m.type === 'system' && m.content.includes('局势摘要'));

  return (
    <div className="card-glass p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-wolf-text flex items-center gap-2">
          <LayoutDashboard className="w-4 h-4 text-wolf-purple-light" />
          局势黑板
        </h3>
        <span className="text-xs text-wolf-text/50">
          {gameState.day > 1 ? `第 ${gameState.day} 天` : '第 1 天'} · {getPhaseText(gameState.phase)}
        </span>
      </div>

      <div className="space-y-3 text-sm">
        <div>
          <div className="flex items-center gap-2 text-wolf-text/70 mb-1">
            <Users className="w-3.5 h-3.5" />
            <span>存活 {alive.length} 人</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {alive.length > 0 ? (
              alive.map((p) => (
                <span key={p.id} className="px-2 py-0.5 rounded-full bg-green-500/10 border border-green-500/20 text-green-300 text-xs">
                  {p.name}
                </span>
              ))
            ) : (
              <span className="text-wolf-text/40 text-xs">无</span>
            )}
          </div>
        </div>

        {dead.length > 0 && (
          <div>
            <div className="flex items-center gap-2 text-wolf-text/70 mb-1">
              <Skull className="w-3.5 h-3.5" />
              <span>已出局 {dead.length} 人</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {dead.map((p) => (
                <span key={p.id} className="px-2 py-0.5 rounded-full bg-red-500/10 border border-red-500/20 text-red-300/80 text-xs line-through">
                  {p.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {latestSummary && (
          <div className="p-2.5 bg-wolf-dark/40 rounded-lg border border-wolf-purple/15">
            <p className="text-xs text-wolf-text/85 leading-relaxed">{latestSummary.content}</p>
          </div>
        )}

        {!latestSummary && (
          <div className="flex items-start gap-2 p-2.5 bg-wolf-dark/40 rounded-lg border border-wolf-purple/15">
            <AlertTriangle className="w-3.5 h-3.5 text-wolf-purple-light mt-0.5 shrink-0" />
            <p className="text-xs text-wolf-text/60 leading-relaxed">
              本局每日局势摘要将在天亮后生成，供参考盘狼。
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
