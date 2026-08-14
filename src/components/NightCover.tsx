import type { ReactNode } from 'react';

export function NightCover({ children, team = 'good', active = true }: { children: ReactNode; team?: 'wolf' | 'good'; active?: boolean }) {
  return <div className={'night-cover night-cover--' + team + (active ? ' is-active' : '')} data-night-team={team} aria-label={team === 'wolf' ? '狼人夜间频道' : '好人夜间频道'}>{children}</div>;
}
