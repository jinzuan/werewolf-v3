import { Bot, Check, CircleUserRound, Skull } from 'lucide-react';
import type { Player } from '../types';
import { ThinkingBadge } from './ThinkingBadge';

interface PlayerTileProps {
  player: Player;
  isMe?: boolean;
  isTurn?: boolean;
  selected?: boolean;
  voteCount?: number;
  thinking?: number;
  onClick?: () => void;
}

export function PlayerTile({ player, isMe, isTurn, selected, voteCount, thinking, onClick }: PlayerTileProps) {
  return <button type="button" className={`day-player ${isTurn ? 'is-turn' : ''} ${selected ? 'is-selected' : ''} ${!player.isAlive ? 'is-dead' : ''}`} onClick={onClick} disabled={!onClick} aria-pressed={selected}>
    <span className="day-player__avatar">{player.isAlive ? (player.isAI ? <Bot size={22} /> : <CircleUserRound size={22} />) : <Skull size={22} />}</span>
    <span className="day-player__body"><strong>{player.name}{isMe ? '（你）' : ''}</strong><small>{player.isAlive ? (isTurn ? '正在发言' : player.isAI ? 'AI 玩家' : '在线玩家') : '已出局'}</small>{thinking !== undefined && <ThinkingBadge progress={thinking} />}</span>
    {selected && <Check className="day-player__check" size={20} />}
    {voteCount !== undefined && <span className="day-player__votes">{voteCount} 票</span>}
  </button>;
}
