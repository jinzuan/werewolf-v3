import type { RoomMember } from './types';

export type SeatAllocationErrorCode =
  | 'ROOM_FULL'
  | 'SEAT_CONFLICT'
  | 'INVALID_SEAT_INDEX';

export class SeatAllocationError extends Error {
  constructor(
    message: string,
    public readonly code: SeatAllocationErrorCode,
    public readonly memberId?: string,
    public readonly seatIndex?: number,
  ) {
    super(message);
    this.name = 'SeatAllocationError';
  }
}

const isPlayer = (member: RoomMember): boolean => member.kind === 'player';

const isValidSeatIndex = (seatIndex: unknown, maxPlayers: number): seatIndex is number =>
  typeof seatIndex === 'number' &&
  Number.isInteger(seatIndex) &&
  seatIndex >= 0 &&
  seatIndex < maxPlayers;

const assertCapacity = (maxPlayers: number): void => {
  if (!Number.isInteger(maxPlayers) || maxPlayers <= 0) {
    throw new SeatAllocationError(
      'A room must have a positive player capacity.',
      'INVALID_SEAT_INDEX',
    );
  }
};

/** Return the occupied player seats without including spectators. */
export const occupiedSeatIndexes = (
  members: readonly RoomMember[],
  maxPlayers: number,
): Set<number> => {
  assertCapacity(maxPlayers);
  const occupied = new Set<number>();
  for (const member of members) {
    if (!isPlayer(member) || member.seatIndex === null || member.seatIndex === undefined) {
      continue;
    }
    if (!isValidSeatIndex(member.seatIndex, maxPlayers)) {
      throw new SeatAllocationError(
        `Member ${member.id} has an invalid seat index.`,
        'INVALID_SEAT_INDEX',
        member.id,
        member.seatIndex,
      );
    }
    if (occupied.has(member.seatIndex)) {
      throw new SeatAllocationError(
        `Seat ${member.seatIndex} is assigned more than once.`,
        'SEAT_CONFLICT',
        member.id,
        member.seatIndex,
      );
    }
    occupied.add(member.seatIndex);
  }
  return occupied;
};

/**
 * Find a deterministic free seat. Seats are zero-based and are never assigned
 * to spectators. A requested seat is honoured only when it is valid and free.
 */
export const nextSeatIndex = (
  members: readonly RoomMember[],
  maxPlayers: number,
  requestedSeatIndex?: number,
): number => {
  const occupied = occupiedSeatIndexes(members, maxPlayers);
  if (
    requestedSeatIndex !== undefined &&
    isValidSeatIndex(requestedSeatIndex, maxPlayers) &&
    !occupied.has(requestedSeatIndex)
  ) {
    return requestedSeatIndex;
  }

  for (let seatIndex = 0; seatIndex < maxPlayers; seatIndex += 1) {
    if (!occupied.has(seatIndex)) return seatIndex;
  }
  throw new SeatAllocationError(
    'There are no player seats left.',
    'ROOM_FULL',
  );
};

export const allocateSeatIndex = nextSeatIndex;
export const findNextSeatIndex = nextSeatIndex;

/** Assign missing player seats while preserving every existing assignment. */
export const allocateSeats = (
  members: readonly RoomMember[],
  maxPlayers: number,
): RoomMember[] => {
  const occupied = occupiedSeatIndexes(members, maxPlayers);
  const result = members.map((member) => ({ ...member }));
  for (const member of result) {
    if (!isPlayer(member) || member.seatIndex !== undefined && member.seatIndex !== null) {
      if (!isPlayer(member)) member.seatIndex = null;
      continue;
    }
    let seatIndex = 0;
    while (occupied.has(seatIndex) && seatIndex < maxPlayers) seatIndex += 1;
    if (seatIndex >= maxPlayers) {
      throw new SeatAllocationError(
        'There are no player seats left.',
        'ROOM_FULL',
        member.id,
      );
    }
    member.seatIndex = seatIndex;
    occupied.add(seatIndex);
  }
  return result;
};

export const normalizeSeatAssignments = allocateSeats;

export interface SeatLayoutIssue {
  memberId: string;
  code: 'INVALID_SEAT_INDEX' | 'SEAT_CONFLICT';
  seatIndex?: number | null;
}

export interface SeatLayout {
  valid: boolean;
  occupied: number[];
  issues: SeatLayoutIssue[];
}

/** Inspect persisted seats without throwing, useful for policy diagnostics. */
export const inspectSeatLayout = (
  members: readonly RoomMember[],
  maxPlayers: number,
): SeatLayout => {
  const occupied = new Map<number, string>();
  const issues: SeatLayoutIssue[] = [];
  if (!Number.isInteger(maxPlayers) || maxPlayers <= 0) {
    return { valid: false, occupied: [], issues: [] };
  }
  for (const member of members) {
    if (!isPlayer(member) || member.seatIndex === null || member.seatIndex === undefined) {
      continue;
    }
    if (!isValidSeatIndex(member.seatIndex, maxPlayers)) {
      issues.push({
        memberId: member.id,
        code: 'INVALID_SEAT_INDEX',
        seatIndex: member.seatIndex,
      });
      continue;
    }
    const previous = occupied.get(member.seatIndex);
    if (previous !== undefined) {
      issues.push({
        memberId: member.id,
        code: 'SEAT_CONFLICT',
        seatIndex: member.seatIndex,
      });
      continue;
    }
    occupied.set(member.seatIndex, member.id);
  }
  return {
    valid: issues.length === 0,
    occupied: [...occupied.keys()].sort((left, right) => left - right),
    issues,
  };
};

export const validateSeatLayout = inspectSeatLayout;

export const countPlayerMembers = (members: readonly RoomMember[]): number =>
  members.filter(isPlayer).length;

export const countHumanPlayers = (members: readonly RoomMember[]): number =>
  members.filter((member) => isPlayer(member) && !member.isAI).length;

export const countComputerPlayers = (members: readonly RoomMember[]): number =>
  members.filter((member) => isPlayer(member) && Boolean(member.isAI)).length;

/** Object-oriented seam for application services that keep a room capacity. */
export class SeatAllocator {
  constructor(public readonly maxPlayers: number) {
    assertCapacity(maxPlayers);
  }

  nextSeatIndex(
    members: readonly RoomMember[],
    requestedSeatIndex?: number,
  ): number {
    return nextSeatIndex(members, this.maxPlayers, requestedSeatIndex);
  }

  allocate(members: readonly RoomMember[]): RoomMember[] {
    return allocateSeats(members, this.maxPlayers);
  }

  inspect(members: readonly RoomMember[]): SeatLayout {
    return inspectSeatLayout(members, this.maxPlayers);
  }
}
