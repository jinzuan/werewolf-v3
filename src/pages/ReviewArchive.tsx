import { useEffect, useState } from 'react';
import { History, ArrowLeft, Trophy, MessageSquare, Trash2, Bot, User } from 'lucide-react';
import { fetchArchives, clearServerArchives } from '../net/socket';
import { getRoleInfo } from '../utils/roleConfig';
import type { ArchiveRecord } from '../net/protocol';

interface ReviewArchiveProps {
  onNavigate: (path: string) => void;
}

export const ReviewArchive = ({ onNavigate }: ReviewArchiveProps) => {
  const [archives, setArchives] = useState<ArchiveRecord[]>([]);
  const [selected, setSelected] = useState<ArchiveRecord | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const list = await fetchArchives();
      setArchives(list);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleClear = async () => {
    await clearServerArchives();
    setArchives([]);
    setSelected(null);
  };

  return (
    <div className="min-h-screen p-4 md:p-8 relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-16 left-1/3 w-96 h-96 bg-purple-700/5 rounded-full blur-3xl" />
      </div>

      <div className="max-w-5xl mx-auto relative z-10">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-2xl md:text-3xl font-bold text-gradient flex items-center gap-3">
              <History className="w-7 h-7" /> 复盘回看
            </h2>
            <p className="text-sm text-purple-200/40 mt-1">联机对局（含斗蛐蛐）的复盘存档列表，按局回看</p>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => onNavigate('/online')} className="btn-secondary flex items-center gap-2">
              <ArrowLeft className="w-4 h-4" /> 返回
            </button>
            {archives.length > 0 && (
              <button onClick={handleClear} className="btn-secondary flex items-center gap-2 text-red-400">
                <Trash2 className="w-4 h-4" /> 清空
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="card p-12 text-center text-wolf-text/50">加载中...</div>
        ) : archives.length === 0 ? (
          <div className="card p-12 text-center">
            <div className="text-5xl mb-4">📋</div>
            <p className="text-wolf-text/60">暂无复盘存档</p>
            <p className="text-wolf-text/40 text-sm mt-1">打一局联机对局或斗蛐蛐后会自动生成</p>
          </div>
        ) : selected ? (
          <div className="card-glass-elevated p-6">
            <button onClick={() => setSelected(null)} className="text-xs text-purple-200/40 hover:text-purple-200/80 mb-4 flex items-center gap-1">
              <ArrowLeft className="w-3.5 h-3.5" /> 返回列表
            </button>
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl ${selected.winner === 'wolf' ? 'bg-red-500/15 border border-red-500/25' : 'bg-blue-500/15 border border-blue-500/25'}`}>
                {selected.winner === 'wolf' ? '🐺' : '✨'}
              </div>
              <div>
                <h3 className="text-lg font-bold text-wolf-text">{selected.roomName} <span className="text-xs font-mono text-wolf-text/40">{selected.roomCode}</span></h3>
                <p className="text-xs text-wolf-text/50">
                  {new Date(selected.endedAt).toLocaleString('zh-CN')} · 第{selected.day}天 · {selected.winner === 'wolf' ? '🐺 狼人胜' : '✨ 好人胜'} · {selected.kind === 'auto' ? '斗蛐蛐' : '联机'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
              <div className="card-glass p-4">
                <h4 className="font-semibold text-wolf-text mb-3 flex items-center gap-2"><User className="w-4 h-4 text-wolf-purple-light" /> 玩家与身份</h4>
                <div className="flex flex-wrap gap-2">
                  {selected.players.map((p, i) => (
                    <span key={i} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border ${p.role === 'wolf' ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-blue-500/20 bg-blue-500/5 text-wolf-text'}`}>
                      {p.isAI ? <Bot className="w-3 h-3 text-blue-400" /> : <User className="w-3 h-3" />}
                      {p.name} · {p.role ? getRoleInfo(p.role).name : '?'}
                    </span>
                  ))}
                </div>
              </div>
              <div className="card-glass p-4">
                <h4 className="font-semibold text-wolf-text mb-3 flex items-center gap-2"><Trophy className="w-4 h-4 text-orange-400" /> 死亡时间线</h4>
                <div className="space-y-1.5">
                  {selected.deaths.length === 0 ? (
                    <p className="text-wolf-text/40 text-sm">无人死亡</p>
                  ) : (
                    selected.deaths.map((d, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <span className="text-wolf-text/60">第{d.day}</span>
                        <span className="text-red-400">💀</span>
                        <span className="text-wolf-text">{d.name}</span>
                        <span className="text-wolf-text/40 text-xs">({d.reason})</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="card-glass p-4">
              <h4 className="font-semibold text-wolf-text mb-3 flex items-center gap-2"><MessageSquare className="w-4 h-4 text-wolf-purple-light" /> 复盘记录</h4>
              <div className="space-y-2 max-h-[420px] overflow-y-auto">
                {selected.reviewMessages.length === 0 ? (
                  <p className="text-wolf-text/40 text-sm">本局未开启复盘</p>
                ) : (
                  selected.reviewMessages.map((m) => (
                    <div key={m.id} className={`rounded-xl p-3 border text-sm ${m.playerId === 'system' ? 'bg-yellow-500/10 border-yellow-500/20 text-yellow-300' : 'bg-wolf-purple/5 border-wolf-purple/15 text-wolf-text'}`}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold">{m.playerName}</span>
                        <span className="text-xs text-wolf-text/40">{new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <p className="text-wolf-text/85 leading-relaxed">{m.content}</p>
                    </div>
                  ))
                )}
              </div>
            </div>

            {selected.insights.length > 0 && (
              <div className="card-glass p-4 mt-4">
                <h4 className="font-semibold text-wolf-text mb-3">📚 已回写经验库的心得</h4>
                <div className="space-y-1.5">
                  {selected.insights.map((ins, i) => (
                    <div key={i} className="text-sm text-wolf-text/80 flex items-start gap-2">
                      <span className="text-wolf-purple flex-shrink-0">{getRoleInfo(ins.role).icon} {getRoleInfo(ins.role).name}:</span>
                      <span>{ins.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {archives.map((a) => (
              <button
                key={a.id}
                onClick={() => setSelected(a)}
                className="card-glass p-5 text-left hover:border-wolf-purple/30 transition-all group"
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-wolf-text group-hover:text-wolf-purple-light transition-colors">{a.roomName}</h3>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${a.winner === 'wolf' ? 'bg-red-500/15 text-red-400' : 'bg-blue-500/15 text-blue-400'}`}>
                    {a.winner === 'wolf' ? '🐺 狼胜' : '✨ 好胜'}
                  </span>
                </div>
                <p className="text-xs text-wolf-text/40 font-mono mb-3">{a.roomCode}</p>
                <div className="flex items-center gap-3 text-xs text-wolf-text/50">
                  <span>{new Date(a.endedAt).toLocaleString('zh-CN')}</span>
                  <span>· 第{a.day}天</span>
                  <span>· {a.playerCount}人</span>
                  {a.kind === 'auto' && <span className="text-yellow-400">斗蛐蛐</span>}
                </div>
                <div className="mt-3 text-xs text-wolf-text/40">复盘消息 {a.reviewMessages.length} 条 · 心得 {a.insights.length} 条</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
