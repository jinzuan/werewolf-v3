import { useEffect, useRef, useState } from 'react';
import type { DomainEvent } from '../../../shared/events';
import { isSpeechEvent } from '../../v3/visibility';

type UnreadEvent = Pick<DomainEvent, 'eventType' | 'sequence'>;

interface MobileMatchUnreadOptions {
  chatTab?: string | null;
  eventTab?: string;
}

/**
 * Counts events received after the current game projection was mounted.
 * Historical replay is used as the initial cursor, so reconnecting does not
 * turn every recovered event into a misleading notification.
 */
export function useMobileMatchUnread(
  events: readonly UnreadEvent[],
  gameId: string | null | undefined,
  activeTab: string,
  {
    chatTab = 'chat',
    eventTab = 'events',
  }: MobileMatchUnreadOptions = {},
): Readonly<Record<string, number>> {
  const [unread, setUnread] = useState<Record<string, number>>({});
  const cursorRef = useRef<{ gameId: string | null | undefined; sequence: number }>({
    gameId: null,
    sequence: 0,
  });

  useEffect(() => {
    const latestSequence = events.reduce(
      (latest, event) => Math.max(latest, event.sequence),
      0,
    );
    const cursor = cursorRef.current;

    if (cursor.gameId !== gameId) {
      cursorRef.current = { gameId, sequence: latestSequence };
      setUnread({});
      return;
    }

    if (gameId === null || gameId === undefined || latestSequence <= cursor.sequence) {
      return;
    }

    const newEvents = events.filter(
      (event) => event.sequence > cursor.sequence && event.eventType !== 'game.state_updated',
    );
    cursor.sequence = latestSequence;
    if (newEvents.length === 0) return;

    const newSpeechCount = newEvents.filter(isSpeechEvent).length;
    const newEventCount = chatTab === null
      ? newEvents.length
      : newEvents.length - newSpeechCount;
    setUnread((current) => ({
      ...current,
      ...(chatTab !== null && newSpeechCount > 0 && activeTab !== chatTab
        ? { [chatTab]: (current[chatTab] ?? 0) + newSpeechCount }
        : {}),
      ...(newEventCount > 0 && activeTab !== eventTab
        ? { [eventTab]: (current[eventTab] ?? 0) + newEventCount }
        : {}),
    }));
  }, [activeTab, chatTab, eventTab, events, gameId]);

  useEffect(() => {
    setUnread((current) => current[activeTab]
      ? { ...current, [activeTab]: 0 }
      : current);
  }, [activeTab]);

  return unread;
}
