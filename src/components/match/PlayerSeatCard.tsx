import { UserRound } from 'lucide-react';
import type { Player } from '../../../shared/types';
import { seatColorClass } from '../../v3/seatColors';

export type PlayerSeatStatus = 'alive' | 'exiled' | 'night-death';
export type SeerAlignment = 'wolf' | 'good';

const STATUS_LABELS: Record<PlayerSeatStatus, string> = {
  alive: '存活',
  exiled: '流放',
  'night-death': '死亡',
};

interface PlayerSeatCardProps {
  player: Player;
  label: string;
  status: PlayerSeatStatus;
  targetable?: boolean;
  selected?: boolean;
  speaking?: boolean;
  speakerTone?: number;
  checkedAlignment?: SeerAlignment;
  onSelect?: () => void;
}

/** Shared seat projection for the player and public spectator views. */
export function PlayerSeatCard({
  player,
  label,
  status,
  targetable = false,
  selected = false,
  speaking = false,
  speakerTone = 0,
  checkedAlignment,
  onSelect,
}: PlayerSeatCardProps) {
  const statusLabel = STATUS_LABELS[status];
  const className = [
    'v3-player-seat',
    seatColorClass(player.order),
    `v3-player-seat--status-${status}`,
    status !== 'alive' ? 'is-dead' : '',
    selected ? 'is-selected' : '',
    speaking ? `is-speaking v3-player-seat--speaker-${speakerTone}` : '',
  ].filter(Boolean).join(' ');
  const ariaLabel = `${label}，${statusLabel}${targetable ? '，可选择' : ''}`;
  const content = (
    <>
      <span className="v3-player-seat__number">
        {player.order.toString().padStart(2, '0')}
      </span>
      <span className="v3-player-seat__avatar">
        <UserRound size={22} />
      </span>
      <span className="v3-player-seat__name">
        <strong>{label}</strong>
        {player.isAI ? <span className="v3-ai-label">AI</span> : null}
        {checkedAlignment ? (
          <span className="v3-player-seat__seer-check" title="预言家已查验">
            已查验·{checkedAlignment === 'wolf' ? '狼人' : '好人'}
          </span>
        ) : null}
      </span>
      <span className="v3-player-seat__status" aria-label={statusLabel} title={statusLabel} />
    </>
  );

  if (onSelect) {
    return (
      <button
        type="button"
        className={className}
        aria-current={speaking ? 'true' : undefined}
        aria-label={ariaLabel}
        title={`${label} · ${statusLabel}`}
        disabled={!targetable}
        onClick={onSelect}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className={className}
      aria-label={ariaLabel}
      title={`${label} · ${statusLabel}`}
      data-player-card="true"
    >
      {content}
    </div>
  );
}
