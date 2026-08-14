import { useEffect, useMemo, useState } from 'react';
import { useGameEngine } from '../hooks/useGameEngine';
import { useAudio } from '../hooks/useAudio';
import { useDaytimeDraft } from '../hooks/useDaytimeDraft';
import { useVoteDraft } from '../hooks/useVoteDraft';
import type { Message } from '../types';
import { ActionBanner } from './ActionBanner';
import { Blackboard } from './Blackboard';
import { BottomActionBar } from './BottomActionBar';
import { FlowRail } from './FlowRail';
import { HunterConfirm } from './HunterConfirm';
import { MessageStream } from './MessageStream';
import { PlayerTile } from './PlayerTile';
import { SpeechDock } from './SpeechDock';
import { VoteSheet, type VoteState } from './VoteSheet';
import { WaitingPanel } from './WaitingPanel';
import { TieBreakPanel } from './TieBreakPanel';
import { CountdownChip } from './CountdownChip';
import { NightActionSheet } from './NightActionSheet';
import { NightCover } from './NightCover';
import { ThinkingProgress } from './ThinkingProgress';
import { WolfDen } from './WolfDen';
import { useNightActionDraft } from '../hooks/useNightActionDraft';

export function RoomDaySurface({ roomCode, playerId, messages = [] }: { roomCode: string; playerId: string | null; messages?: Message[] }) {
  const { snapshot, state, me, isMyTurn, banner, countdown, deadlineExpired, act } = useGameEngine(roomCode, playerId);
  const { notifyTurn } = useAudio();
  const { draft, setDraft, clearDraft } = useDaytimeDraft(roomCode, playerId);
  const { selectedId: voteId, select: selectVote, clear: clearVote } = useVoteDraft(roomCode, playerId);
  const [voteState, setVoteState] = useState<VoteState>('draft');
  const [hunterId, setHunterId] = useState<string | null>(null);
  const [showHunter, setShowHunter] = useState(false);
  useEffect(() => { notifyTurn(isMyTurn); }, [isMyTurn, notifyTurn]);
  const alive = snapshot?.players.filter((player) => player.isAlive) || [];
  const isVoting = state?.phase === 'vote' || state?.phase === 'voting';
  const isHunter = state?.phase === 'hunterShoot';
  const isTie = !!snapshot?.isInTieDebate;
  const [tieId, setTieId] = useState<string | null>(null);
  useEffect(() => {
    if (!isVoting) {
      setVoteState('draft');
      clearVote();
    }
  }, [isVoting, clearVote]);
  const queue = useMemo(() => (state?.speakerOrder || []).map((id) => snapshot?.players.find((player) => player.id === id)).filter((player): player is NonNullable<typeof player> => !!player && player.id !== state?.currentSpeaker && player.isAlive).map((player) => ({ id: player.id, name: player.name })), [snapshot?.players, state?.currentSpeaker, state?.speakerOrder]);
  const voteCounts = useMemo(() => Object.values(state?.votes || {}).reduce<Record<string, number>>((result, target) => { result[target] = (result[target] || 0) + 1; return result; }, {}), [state?.votes]);
  if (!snapshot || !state) return <div className="day-room-surface"><WaitingPanel queue={[]} thinking={{}} /></div>;
  const actionLocked = deadlineExpired;
  if (state.phase === 'night') return <NightSurface roomCode={roomCode} playerId={playerId} snapshot={snapshot} actionLocked={actionLocked} countdown={countdown} messages={messages} onAction={act} />;
  return <main className="day-room-surface"><ActionBanner title={banner.title} detail={actionLocked ? '本阶段时间已到，等待服务端结算' : banner.detail} tone={actionLocked ? 'warning' : banner.tone} countdown={countdown} /><div className="day-room-layout"><section className="day-room-main">{showHunter || isHunter ? <HunterConfirm players={alive} targetId={hunterId} onTarget={setHunterId} onCancel={() => setShowHunter(false)} onConfirm={() => { if (hunterId && !actionLocked) act({ t: 'hunter-shoot', targetId: hunterId }); setShowHunter(false); }} /> : isTie ? <TieBreakPanel players={snapshot.players.filter((player) => snapshot.tiePlayers.includes(player.id) && player.isAlive)} selectedId={tieId} round={snapshot.tieDebateRound} onSelect={setTieId} onSubmit={() => { if (tieId && !actionLocked) act({ t: 'vote', targetId: tieId, reason: 'PK' }); }} /> : isVoting ? <VoteSheet players={alive} selectedId={voteId} state={voteState} voteCounts={voteCounts} onSelect={(id) => { selectVote(id); setVoteState('draft'); }} onSubmit={() => { if (voteId && !actionLocked) { act({ t: 'vote', targetId: voteId, reason: '' }); setVoteState('submitted'); } }} /> : <><div className="day-player-grid">{snapshot.players.map((player) => <PlayerTile key={player.id} player={player} isMe={player.id === playerId} isTurn={player.id === state.currentSpeaker} thinking={snapshot.thinkingPlayers[player.id]} />)}</div><SpeechDock enabled={!!me?.isAlive && isMyTurn && !actionLocked} initialValue={draft} onChange={setDraft} onSubmit={(content) => { clearDraft(); act({ t: 'speak', content }); }} onSkip={() => { clearDraft(); act({ t: 'skip-speech' }); }} reason={actionLocked ? '本阶段时间已到，等待服务端结算' : me?.isAlive ? undefined : '你已出局，无法发言'} /></>}<MessageStream messages={messages} /></section><aside className="day-room-side"><FlowRail current={isTie ? 'pk' : isVoting ? 'vote' : isHunter ? 'lastWords' : 'speech'} queue={queue} thinking={snapshot.thinkingPlayers} /><WaitingPanel queue={queue} thinking={snapshot.thinkingPlayers} voteSnapshot={Object.keys(voteCounts).length ? `${Object.entries(voteCounts).map(([id, count]) => `${snapshot.players.find((player) => player.id === id)?.name || '未知'} ${count}票`).join(' · ')}` : undefined} summary={banner.detail} /><Blackboard voteSnapshot={Object.keys(voteCounts).length ? '票型已更新' : undefined} summary={banner.detail} /></aside></div><BottomActionBar canSpeak={!!me?.isAlive && isMyTurn && !isVoting && !isTie && !actionLocked} canVote={!!me?.isAlive && (isVoting || isTie) && voteState !== 'locked' && !actionLocked} canSkip={!!me?.isAlive && isMyTurn && !isVoting && !isTie && !actionLocked} onSpeak={() => document.querySelector<HTMLTextAreaElement>('.day-speech-dock textarea')?.focus()} onVote={() => document.querySelector<HTMLElement>('.day-vote-sheet')?.scrollIntoView({ behavior: 'smooth', block: 'center' })} onSkip={() => act({ t: 'skip-speech' })} />{isHunter && !showHunter && <button className="day-hunter-launch" disabled={actionLocked} onClick={() => setShowHunter(true)}>打开开枪确认</button>}</main>;
}

function NightSurface({ roomCode, playerId, snapshot, actionLocked, countdown, messages, onAction }: { roomCode: string; playerId: string | null; snapshot: NonNullable<ReturnType<typeof useGameEngine>['snapshot']>; actionLocked: boolean; countdown: string; messages: Message[]; onAction: (action: Parameters<ReturnType<typeof useGameEngine>['act']>[0]) => void }) {
  const { draft, setDraft, clearDraft } = useNightActionDraft(roomCode, playerId);
  const state = snapshot.gameState;
  if (!state) return null;
  const isWolf = snapshot.myRole === 'wolf';
  const alive = snapshot.players.filter((player) => player.isAlive);
  const queue = alive.filter((player) => ['wolf', 'seer', 'witch', 'guardian'].includes(player.role || ''));
  const roleDone = !!(playerId && state.actionDone[playerId]) || (snapshot.myRole === 'guardian' && state.guardianActionComplete) || (snapshot.myRole === 'witch' && state.witchActionComplete);
  const locked = actionLocked || roleDone || (isWolf && !!state.actionDone['wolf_team']);
  const send = (action: 'kill' | 'check' | 'heal' | 'poison' | 'guard', targetId: string) => onAction({ t: 'night-action', action, targetId });
  return <NightCover team={isWolf ? 'wolf' : 'good'}><main className="day-room-surface night-room-surface"><header className="night-room-header"><div><span className="night-eyebrow">第 {state.day} 夜 · {isWolf ? '狼人频道' : '夜间行动'}</span><h1>{isWolf ? '狼队正在决定今晚的目标' : '夜幕已降，轮到特殊角色行动'}</h1></div><CountdownChip countdown={countdown} expired={actionLocked} /></header><div className="day-room-layout"><section className="day-room-main">{isWolf ? <WolfDen players={alive.filter((player) => player.role !== 'wolf')} messages={snapshot.wolfChatMessages} selectedTarget={draft.targetId} onTarget={(id) => setDraft({ action: 'kill', targetId: id })} onConfirm={() => { if (draft.targetId && !locked) { send('kill', draft.targetId); clearDraft(); } }} locked={locked} reason={actionLocked ? '时间已到，等待服务端结算' : state.actionDone['wolf_team'] ? '狼队已锁定共同决策' : undefined} /> : <NightActionSheet roomCode={roomCode} playerId={playerId} role={snapshot.myRole} players={snapshot.players} nightKey={String(state.day)} actionDone={roleDone} lastGuardTarget={state.guardianLastTarget} healAvailable={state.witchHasHealPotion} poisonAvailable={state.witchHasPoisonPotion} locked={actionLocked} spectator={snapshot.isSpectator} onAction={send} onSkip={() => onAction({ t: 'skip-night' })} />}<MessageStream messages={messages} /></section><aside className="day-room-side"><section className="day-waiting-panel night-waiting-panel"><header><span className="night-eyebrow">夜间等待区</span><h2>行动进度</h2></header><div className="day-waiting-block"><strong>发言队列</strong>{queue.length ? queue.map((player) => <div key={player.id}><span>{player.name}</span><span>{state.actionDone[player.id] ? '已锁定' : '等待行动'}</span></div>) : <p>当前没有可见的发言队列，AI 行动由服务端并行推进。</p>}</div><div className="day-waiting-block"><strong>思考进度</strong>{Object.entries(snapshot.thinkingPlayers).length ? Object.entries(snapshot.thinkingPlayers).map(([id, progress]) => <ThinkingProgress key={id} name={snapshot.players.find((player) => player.id === id)?.name} progress={progress} />) : <p>当前没有 AI 思考内容。</p>}</div><div className="day-waiting-block"><strong>票型快照</strong><p>{isWolf ? (Object.keys(snapshot.wolfVotes).length ? '狼队票型已更新，确认前仍可改选。' : '狼队尚未形成票型。') : '夜间票型对当前视角隐藏，结算后公布结果。'}</p></div><div className="day-waiting-block"><strong>局势摘要</strong><p>{locked ? '你的行动已锁定，等待其他角色完成。' : '请选择目标；确认前仍可点选修改。'}</p></div></section></aside></div></main></NightCover>;
}
