import { BarChart3, ScrollText } from 'lucide-react';

export function Blackboard({ voteSnapshot, summary }: { voteSnapshot?: string; summary?: string }) {
  return <section className="day-blackboard"><header><ScrollText size={19} /><span>局势黑板</span></header><div><BarChart3 size={16} /><strong>票型快照</strong><p>{voteSnapshot || '暂未开始投票'}</p></div><div><strong>当前摘要</strong><p>{summary || '等待发言记录沉淀'}</p></div></section>;
}
