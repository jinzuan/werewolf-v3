import { Timer } from 'lucide-react';

export function CountdownChip({ countdown, expired = false }: { countdown: string; expired?: boolean }) {
  const visible = countdown !== '—';
  return <span className={'night-countdown' + (expired ? ' is-expired' : '')} role="timer" aria-label={visible ? '夜间剩余时间 ' + countdown : '当前阶段没有倒计时'}><Timer size={16} aria-hidden="true" /><strong>{visible ? countdown : '不限时'}</strong></span>;
}
