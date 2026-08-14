import { Check, LockKeyhole } from 'lucide-react';
import type { Player } from '../types';
import { PlayerTile } from './PlayerTile';

export type VoteState = 'draft' | 'submitted' | 'locked';
export function VoteSheet({ players, selectedId, state, voteCounts, onSelect, onSubmit }: { players: Player[]; selectedId: string | null; state: VoteState; voteCounts?: Record<string, number>; onSelect: (id: string) => void; onSubmit: () => void }) {
  const locked = state === 'locked';
  return <section className="day-vote-sheet"><header><div><span className="day-eyebrow">今日投票</span><h2>{state === 'draft' ? '选择你要放逐的玩家' : state === 'submitted' ? '已提交投票' : '投票已锁定'}</h2></div><span className={`day-state day-state--${state}`}>{locked ? <LockKeyhole size={15} /> : state === 'submitted' ? <Check size={15} /> : null}{state === 'draft' ? '草稿，可更改' : state === 'submitted' ? '已提交，可更改' : '已锁定'}</span></header><div className="day-vote-grid">{players.filter((player) => player.isAlive).map((player) => <PlayerTile key={player.id} player={player} selected={selectedId === player.id} voteCount={voteCounts?.[player.id]} onClick={locked ? undefined : () => onSelect(player.id)} />)}</div><p className="day-vote-help">{locked ? '阶段已锁定，等待服务端结算' : selectedId ? '已选择目标，确认后仍可在阶段锁定前修改' : '请选择一名存活玩家'}</p><button className="day-button day-button--primary day-vote-submit" disabled={!selectedId || locked} onClick={onSubmit}>{state === 'submitted' ? '更新投票' : '确认投票'}</button></section>;
}
