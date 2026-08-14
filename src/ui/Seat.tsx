import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Status, type StatusTone } from './Status';

export type SeatKind = 'player' | 'computer' | 'spectator' | 'empty';
export type SeatPresence = 'online' | 'offline' | 'ready' | 'waiting' | 'idle';

interface SeatProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  seatNumber: number;
  name?: string;
  kind?: SeatKind;
  presence?: SeatPresence;
  host?: boolean;
  avatar?: ReactNode;
  selected?: boolean;
  statusLabel?: string;
  meta?: string;
}

const kindLabels: Record<SeatKind, string> = {
  player: '玩家',
  computer: '电脑',
  spectator: '观战',
  empty: '空席',
};

const presenceLabels: Record<SeatPresence, string> = {
  online: '在线',
  offline: '离线',
  ready: '已准备',
  waiting: '等待准备',
  idle: '等待加入',
};

const presenceTones: Record<SeatPresence, StatusTone> = {
  online: 'success',
  offline: 'danger',
  ready: 'success',
  waiting: 'warning',
  idle: 'neutral',
};

export function Seat({
  seatNumber,
  name,
  kind = 'player',
  presence = 'online',
  host = false,
  avatar,
  selected = false,
  statusLabel,
  meta,
  className,
  disabled,
  ...props
}: SeatProps) {
  const isEmpty = kind === 'empty';
  const displayName = name || (isEmpty ? '等待加入' : '未命名村民');
  const label = statusLabel || presenceLabels[isEmpty ? 'idle' : presence];

  return (
    <button
      type="button"
      className={cn(
        'ww-seat',
        `ww-seat--${kind}`,
        `ww-seat--${presence}`,
        selected && 'is-selected',
        disabled && 'is-disabled',
        className,
      )}
      aria-label={`${seatNumber}号席位，${displayName}，${kindLabels[kind]}，${label}`}
      aria-pressed={selected}
      disabled={disabled ?? isEmpty}
      {...props}
    >
      <span className="ww-seat__number" aria-hidden="true">
        {String(seatNumber).padStart(2, '0')}
      </span>
      <span className="ww-seat__avatar" aria-hidden="true">
        {avatar || (isEmpty ? '＋' : kind === 'computer' ? '机' : kind === 'spectator' ? '观' : '民')}
      </span>
      <span className="ww-seat__body">
        <strong>{displayName}</strong>
        <span className="ww-seat__tags">
          <span className="ww-seat__kind">{kindLabels[kind]}</span>
          {host ? <span className="ww-seat__host">房主</span> : null}
        </span>
        <Status tone={presenceTones[isEmpty ? 'idle' : presence]} label={label} detail={meta} />
      </span>
    </button>
  );
}
