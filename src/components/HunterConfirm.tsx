import { AlertTriangle, Crosshair, ShieldAlert } from 'lucide-react';
import type { Player } from '../types';
import { PlayerTile } from './PlayerTile';

export function HunterConfirm({ players, targetId, onTarget, onConfirm, onCancel }: { players: Player[]; targetId: string | null; onTarget: (id: string) => void; onConfirm: () => void; onCancel?: () => void }) {
  return <section className="day-hunter-confirm" role="dialog" aria-modal="true" aria-labelledby="hunter-title"><header><Crosshair size={22} /><div><span className="day-eyebrow">猎人开枪</span><h2 id="hunter-title">选择一名玩家</h2></div></header><div className="day-consequence"><AlertTriangle size={19} /><span><strong>确认前请注意</strong>：开枪后你立即死亡，无法撤回。</span></div><div className="day-hunter-grid">{players.filter((player) => player.isAlive).map((player) => <PlayerTile key={player.id} player={player} selected={targetId === player.id} onClick={() => onTarget(player.id)} />)}</div><div className="day-hunter-actions">{onCancel && <button className="day-button day-button--quiet" onClick={onCancel}>再想想</button>}<button className="day-button day-button--danger" title={targetId ? '确认后你会立即死亡' : '请先选择目标'} disabled={!targetId} onClick={onConfirm}><ShieldAlert size={17} />确认开枪</button></div></section>;
}
