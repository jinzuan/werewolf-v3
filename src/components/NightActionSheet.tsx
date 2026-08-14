import { Check, Eye, Heart, Shield, Skull, Sparkles, Target } from 'lucide-react';
import type { Player, Role } from '../types';
import { useNightActionDraft, type NightActionKind } from '../hooks/useNightActionDraft';

const ACTIONS: Record<Exclude<Role, 'hunter' | 'villager'>, Array<{ action: NightActionKind; label: string; description: string; icon: typeof Target }>> = {
  wolf: [{ action: 'kill', label: '狼刀', description: '向狼队提交一名夜间目标', icon: Target }],
  seer: [{ action: 'check', label: '查验', description: '查看目标的阵营结果', icon: Eye }],
  witch: [{ action: 'heal', label: '解药', description: '救回今晚被袭击的玩家', icon: Heart }, { action: 'poison', label: '毒药', description: '毒杀一名存活玩家', icon: Skull }],
  guardian: [{ action: 'guard', label: '守护', description: '保护一名玩家免受狼刀', icon: Shield }],
};

export function NightActionSheet({ roomCode, playerId, role, players, nightKey = 'current', actionDone, lastGuardTarget, healAvailable = true, poisonAvailable = true, locked = false, spectator = false, reason, onAction, onSkip }: { roomCode: string; playerId: string | null; role: Role | null; players: Player[]; nightKey?: string; actionDone: boolean; lastGuardTarget?: string | null; healAvailable?: boolean; poisonAvailable?: boolean; locked?: boolean; spectator?: boolean; reason?: string; onAction: (action: NightActionKind, targetId: string) => void; onSkip: () => void }) {
  const { draft, setDraft, clearDraft } = useNightActionDraft(roomCode, playerId, nightKey);
  const choices = role && role in ACTIONS ? ACTIONS[role as Exclude<Role, 'hunter' | 'villager'>] : [];
  const targets = players.filter((player) => player.isAlive && (role === 'wolf' ? player.role !== 'wolf' : player.id !== playerId) && (role !== 'guardian' || player.id !== lastGuardTarget));
  const actionDisabled = (action: NightActionKind) => (action === 'heal' && !healAvailable) || (action === 'poison' && !poisonAvailable);
  const canConfirm = !!draft.action && !!draft.targetId && !actionDone && !locked && !actionDisabled(draft.action);
  const targetReason = !draft.action ? '先选择行动，再选择目标' : actionDisabled(draft.action) ? '该药剂已用完，请选择其他行动或跳过' : targets.length === 0 ? role === 'guardian' ? '今晚没有可守护目标（不能连续守护同一人）' : '当前没有可用目标' : undefined;
  const lockedReason = actionDone ? '你的夜间行动已锁定' : locked ? (reason || '阶段已锁定，等待服务端结算') : undefined;

  if (spectator) return <section className="night-action-sheet night-action-sheet--waiting"><Sparkles size={22} /><strong>观战模式</strong><p>夜间行动对观战者不可见，结算后会公布公开结果。</p></section>;
  if (!role || role === 'villager') return <section className="night-action-sheet night-action-sheet--waiting"><Sparkles size={22} /><strong>平民夜间等待</strong><p>特殊角色正在行动，夜幕结束后会公布结果。</p></section>;
  if (role === 'hunter') return <section className="night-action-sheet night-action-sheet--waiting"><Target size={22} /><strong>猎人夜间待命</strong><p>猎人技能在出局后的开枪阶段开放，今晚无需行动。</p></section>;

  return <section className="night-action-sheet" aria-label={role + '夜间行动'}><header><div><span className="night-eyebrow">夜间操作 · {role === 'wolf' ? '狼人' : role === 'seer' ? '预言家' : role === 'witch' ? '女巫' : '守卫'}</span><h2>选择你的行动</h2></div><span className={actionDone || locked ? 'night-lock is-locked' : 'night-lock'}>{actionDone || locked ? '已锁定' : '可修改'}</span></header><div className="night-action-options">{choices.map(({ action, label, description, icon: Icon }) => <button key={action} type="button" className={draft.action === action ? 'is-selected' : ''} onClick={() => setDraft({ action, targetId: null })} disabled={actionDone || locked || actionDisabled(action)} aria-pressed={draft.action === action}><Icon size={18} /><span><strong>{label}</strong><small>{actionDisabled(action) ? '药剂已用完' : description}</small></span>{draft.action === action && <Check size={18} />}</button>)}</div><div className="night-target-grid"><div className="night-section-label">目标 <small>{draft.targetId ? '已选择，可重新点选' : '请选择一名玩家'}</small></div>{targets.map((player) => <button key={player.id} type="button" className={draft.targetId === player.id ? 'is-selected' : ''} onClick={() => setDraft({ targetId: player.id })} disabled={actionDone || locked || !draft.action || actionDisabled(draft.action)} aria-pressed={draft.targetId === player.id}><span>{player.name}{player.id === playerId ? '（你）' : ''}</span><small>{player.isAI ? 'AI' : '真人'} · {player.isAlive ? '存活' : '出局'}</small>{draft.targetId === player.id && <Check size={16} />}</button>)}</div>{lockedReason && <p className="night-action-reason" role="status">{lockedReason}</p>}<footer><button type="button" className="btn-secondary" onClick={() => { clearDraft(); onSkip(); }} disabled={actionDone || locked}>跳过</button><button type="button" className="btn-primary" onClick={() => { if (draft.action && draft.targetId) { onAction(draft.action, draft.targetId); clearDraft(); } }} disabled={!canConfirm}>确认并锁定</button></footer></section>;
}
