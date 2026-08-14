import { Check, Circle, MessageCircle, ShieldAlert, Vote } from 'lucide-react';

const steps = [{ key: 'speech', label: '发言', icon: MessageCircle }, { key: 'vote', label: '投票', icon: Vote }, { key: 'pk', label: '平票 PK', icon: ShieldAlert }, { key: 'lastWords', label: '遗言', icon: Circle }];
export function FlowRail({ current, queue = [], thinking = {} }: { current: string; queue?: Array<{ id: string; name: string }>; thinking?: Record<string, number> }) {
  const currentIndex = steps.findIndex((step) => step.key === current);
  return <aside className="day-flow-rail"><div className="day-eyebrow">流程</div>{steps.map((step, index) => { const Icon = step.icon; return <div className={`day-flow-step ${index === currentIndex ? 'is-current' : ''} ${index < currentIndex ? 'is-done' : ''}`} key={step.key}><Icon size={17} /><span>{step.label}</span>{index < currentIndex && <Check size={14} />}</div>; })}<div className="day-flow-queue"><strong>待发言</strong>{queue.length ? queue.map((player) => <div key={player.id}><span>{player.name}</span>{thinking[player.id] !== undefined && <span className="day-flow-queue__thinking">组织中 {thinking[player.id]}%</span>}</div>) : <small>队列已清空</small>}</div></aside>;
}
