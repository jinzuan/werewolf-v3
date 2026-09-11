import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useV3Store } from '../../stores/v3Store';
import { roomStatusLabel } from '../../app/routes/roomRouting';
import { copyText } from '../../lib/copyText';

const viewerLabel = (kind: 'player' | 'spectator', omniscient: boolean): string => {
  if (kind === 'player') return '玩家视角';
  return omniscient ? '全知观战' : '公开观战';
};

/** Room identity that is available from the phone's View tab. */
export function MobileRoomMeta() {
  const room = useV3Store((state) => state.room);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  if (!room) return null;

  const copyRoomCode = async () => {
    try {
      await copyText(room.code);
      setCopied(true);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="v3-mobile-room-meta" aria-label="房间信息">
      <button
        type="button"
        className="v3-mobile-room-meta__code"
        data-glass-role="control"
        data-glass-motion="control"
        onClick={() => void copyRoomCode()}
        aria-label={`复制房间号 ${room.code}`}
      >
        <span>
          <span>房间号</span>
          <strong className="v3-numeric">{room.code}</strong>
        </span>
        <span className="v3-mobile-room-meta__copy-state">
          {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
          {copied ? '已复制' : '点击复制'}
        </span>
      </button>
      <div data-glass-role="item">
        <span>视角</span>
        <strong>{viewerLabel(room.viewer.kind, room.viewer.omniscient)}</strong>
      </div>
      <div data-glass-role="item">
        <span>房间状态</span>
        <strong>{roomStatusLabel(room.status)}</strong>
      </div>
    </div>
  );
}
