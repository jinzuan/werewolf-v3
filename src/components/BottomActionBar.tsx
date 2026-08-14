import { MessageCircle, SkipForward, Target } from 'lucide-react';

export function BottomActionBar({ canSpeak, canVote, canSkip, onSpeak, onVote, onSkip }: { canSpeak: boolean; canVote: boolean; canSkip: boolean; onSpeak: () => void; onVote: () => void; onSkip: () => void }) {
  return <nav className="day-action-bar" aria-label="当前行动"><button title={canSpeak ? '打开公开发言' : '等轮到你发言后开放'} aria-label={canSpeak ? '发言' : '发言，等轮到你后开放'} className="day-action-bar__primary" disabled={!canSpeak} onClick={onSpeak}><MessageCircle size={19} />发言</button><button title={canVote ? '前往投票' : '投票阶段开放'} aria-label={canVote ? '投票' : '投票，投票阶段开放'} disabled={!canVote} onClick={onVote}><Target size={19} />投票</button><button title={canSkip ? '跳过当前发言' : '当前不能跳过'} aria-label={canSkip ? '跳过' : '跳过，当前不能使用'} disabled={!canSkip} onClick={onSkip}><SkipForward size={19} />跳过</button></nav>;
}
