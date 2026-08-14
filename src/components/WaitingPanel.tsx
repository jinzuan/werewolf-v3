import { BrainCircuit, ClipboardList, UsersRound } from 'lucide-react';

export function WaitingPanel({ queue, thinking, voteSnapshot, summary }: { queue: Array<{ id: string; name: string }>; thinking: Record<string, number>; voteSnapshot?: string; summary?: string }) {
  return <section className="day-waiting-panel"><header><UsersRound size={20} /><div><span className="day-eyebrow">等待区</span><h2>局势正在推进</h2></div></header><div className="day-waiting-block"><strong>发言队列</strong>{queue.length ? queue.map((player) => <div key={player.id}><span>{player.name}</span>{thinking[player.id] !== undefined && <span className="day-thinking-inline"><BrainCircuit size={14} />正在组织发言 {thinking[player.id]}%</span>}</div>) : <small>当前没有待发言玩家</small>}</div><div className="day-waiting-block"><strong><ClipboardList size={15} />票型快照</strong><p>{voteSnapshot || '投票开始后显示票型快照'}</p></div><div className="day-waiting-block"><strong>局势摘要</strong><p>{summary || '发言与行动会在这里形成简短摘要'}</p></div></section>;
}
