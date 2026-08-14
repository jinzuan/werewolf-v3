import { Radio, Timer } from 'lucide-react';
import type { ReactNode } from 'react';

export function ActionBanner({ title, detail, countdown, tone = 'quiet', action }: { title: string; detail: string; countdown?: string; tone?: 'quiet' | 'accent' | 'warning' | 'danger'; action?: ReactNode }) {
  return <section className={`day-banner day-banner--${tone}`} aria-live="polite" role="status"><span className="day-banner__icon"><Radio size={20} /></span><div><strong>{title}</strong><span>{detail}</span></div>{countdown && countdown !== '—' && <span className="day-banner__timer" aria-label={`剩余时间 ${countdown}`}><Timer size={16} aria-hidden="true" />{countdown}</span>}{action}</section>;
}
