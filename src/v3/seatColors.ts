/**
 * Seat colors are presentation-only. The index is derived from the fixed
 * seat order, never from a player's role or faction.
 */
export const SEAT_COLOR_COUNT = 12;

export const seatColorIndex = (seatOrder: number): number =>
  Math.max(0, seatOrder - 1) % SEAT_COLOR_COUNT;

export const seatColorClass = (seatOrder: number): string =>
  `v3-seat-color-${seatColorIndex(seatOrder)}`;
