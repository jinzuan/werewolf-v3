import { ShieldAlert } from 'lucide-react';
import type { Player } from '../types';
import { PlayerTile } from './PlayerTile';

export function TieBreakPanel({ players, selectedId, round, onSelect, onSubmit }: { players: Player[]; selectedId: string | null; round: number; onSelect: (id: string) => void; onSubmit: () => void }) {
  return <section className="day-tie-panel" aria-labelledby="tie-break-title"><header><ShieldAlert size={21} /><div><span className="day-eyebrow">平票 PK · 第 {round} 轮</span><h2 id="tie-break-title">请从平票玩家中选择</h2></div></header><p>只可选择参与平票 PK 的玩家。双方发言结束后进入重新投票。</p><div className="day-tie-grid">{players.map((player) => <PlayerTile key={player.id} player={player} selected={selectedId === player.id} onClick={() => onSelect(player.id)} />)}</div><button className="day-button day-button--primary day-vote-submit" disabled={!selectedId} onClick={onSubmit}>确认 PK 选择</button></section>;
}
