import type { DomainEvent } from '../../shared/events';
import { dayDividerForEvent } from '../v3/presentation/daySeparators';

interface DayDividerProps {
  event: DomainEvent;
  previous: DomainEvent | null;
  fallbackDay?: number;
}

export function DayDivider({ event, previous, fallbackDay = 1 }: DayDividerProps) {
  const label = dayDividerForEvent(event, previous, fallbackDay);
  return label ? <div className="v3-day-divider" role="separator">{label}</div> : null;
}
