import { Eye, LockKeyhole, ShieldAlert } from 'lucide-react';
import type { EventVisibility } from '../../shared/events';
import { cn } from '../lib/utils';
import { Badge } from './Badge';
import type { VisualAsset } from './assetRegistry';

interface ChatBubbleProps {
  author: string;
  time: string;
  children: React.ReactNode;
  variant?: 'self' | 'other' | 'system' | 'wolf';
  visibility?: EventVisibility;
  speakerTone?: number;
  avatarAsset?: VisualAsset;
}

export function ChatBubble({
  author,
  time,
  children,
  variant = 'other',
  visibility = 'public_timeline',
  speakerTone,
  avatarAsset,
}: ChatBubbleProps) {
  if (variant === 'system') {
    return (
      <div className="v3-chat-system">
        <time>{time}</time>
        <span>{children}</span>
      </div>
    );
  }

  return (
    <div className={cn(
      'v3-chat-row',
      `v3-chat-row--${variant}`,
      speakerTone === undefined ? undefined : `v3-seat-color-${speakerTone}`,
    )}>
      <span className="v3-chat-avatar" aria-hidden="true">
        {avatarAsset ? <img src={avatarAsset.src} alt="" /> : <span>{author.slice(0, 1)}</span>}
      </span>
      <article className={cn(
        'v3-chat-bubble',
        `v3-chat-bubble--${variant}`,
        speakerTone === undefined ? undefined : `v3-chat-bubble--speaker-${speakerTone}`,
      )}>
        <header>
          <strong>{author}</strong>
          {variant === 'wolf' ? (
            <Badge tone="danger"><ShieldAlert size={12} />狼人频道</Badge>
          ) : null}
          {visibility !== 'public_timeline' ? (
            <Badge tone="purple"><LockKeyhole size={12} />私密可见</Badge>
          ) : (
            <span className="v3-chat-visibility"><Eye size={12} />公开</span>
          )}
          <time>{time}</time>
        </header>
        <p>{children}</p>
      </article>
    </div>
  );
}
