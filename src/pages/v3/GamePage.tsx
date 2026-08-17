import {
  Bot,
  Check,
  Circle,
  MessageSquare,
  Shield,
  Skull,
  UserRound,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GameAction, GameState } from '../../../shared/types';
import { AppShell } from '../../components/shell/AppShell';
import { MatchShell } from '../../components/shell/MatchShell';
import { useV3Store } from '../../stores/v3Store';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { ChatBubble } from '../../ui/ChatBubble';
import { Input } from '../../ui/Input';
import { RoleCard } from '../../ui/RoleCard';
import { RoleRevealCard } from '../../ui/RoleRevealCard';
import {
  ACTION_DEFINITIONS,
  buildGameCommand,
  currentVoteRoundProjection,
  eligibleTargets,
  healTargetId,
  orderedAllowedActions,
} from '../../v3/actions';
import {
  ACTION_LABELS,
  createPlayerNameResolver,
  describeEvent,
  formatEventTime,
  phaseLabel,
  ROLE_LABELS,
} from '../../v3/presentation';
import {
  remainingServerMs,
  sampleServerClock,
  stageProgress,
  type ServerClockSample,
} from '../../v3/serverClock';
import { formatCountdown } from '../../v3/countdown';
import { MAX_EVENT_WINDOW } from '../../v3/eventStream';
import { chatEventsForViewer } from '../../v3/visibility';

const ROLE_DESCRIPTIONS = {
  wolf: '夜间与狼人队友讨论并决定袭击目标。',
  seer: '每晚查验一名玩家的阵营。',
  witch: '掌握解药与毒药，在夜间作出选择。',
  hunter: '被放逐或击杀后，可选择开枪带走一人。',
  guardian: '每晚守护一名玩家，阻止当晚袭击。',
  villager: '没有夜间技能，通过发言与投票找出狼人。',
} as const;

const ACTION_HELP: Record<GameAction, string> = {
  confirm_role: '确认已查看自己的身份牌。',
  guard: '可守自己，不能连续两晚守同一名玩家。',
  check: '选择一名其他存活玩家查验阵营。',
  wolf_speak: '消息仅对当前存活狼人可见。',
  wolf_vote: '可选择任意存活玩家，也可以空刀。',
  heal: '解药只能用于当前夜晚显示的刀口。',
  poison: '选择一名其他存活玩家使用毒药。',
  skip_night: '放弃当前角色的夜间行动。',
  speak: '向公开时间线提交本轮发言。',
  skip_speech: '白天可直接跳过；遗言阶段若放弃，必须填写理由（例如“懒得说”）。',
  vote: '仅显示本轮规则允许的候选人。',
  abstain: '本轮允许弃票。',
  hunter_shoot: '选择一名其他存活玩家开枪。',
  skip_hunter_shot: '放弃猎人开枪。',
};

export function GamePage() {
  const connected = useV3Store((state) => state.connected);
  const loading = useV3Store((state) => state.loading);
  const error = useV3Store((state) => state.error);
  const room = useV3Store((state) => state.room);
  const session = useV3Store((state) => state.session);
  const snapshot = useV3Store((state) => state.snapshot);
  const events = useV3Store((state) => state.events);
  const dispatch = useV3Store((state) => state.dispatch);
  const [actionDraft, setActionDraft] = useState<{
    activeAction: GameAction | null;
    selectedTarget: string | null;
    message: string;
  }>({
    activeAction: null,
    selectedTarget: null,
    message: '',
  });
  const [roleRevealed, setRoleRevealed] = useState(false);
  const [roleInfoOpen, setRoleInfoOpen] = useState(false);

  const state = snapshot?.gameState ?? null;
  const players = useMemo(() => snapshot?.players ?? [], [snapshot?.players]);
  const myId = session?.actorId ?? '';
  const myPlayer = players.find((player) => player.id === myId);
  const isEliminated = myPlayer?.isAlive === false;
  const dayStage = (state as (GameState & { dayStage?: string | null }) | null)?.dayStage;
  const isLastWordsTurn =
    isEliminated &&
    dayStage === 'last_words' &&
    state?.lastWordsPlayer === myId &&
    state.currentSpeaker === myId;
  // `orderedAllowedActions` returns a new array. Memoize it so the draft reset
  // effect below only runs when the authoritative action set changes; without
  // this, the pre-snapshot empty array caused an update loop and a white page.
  const allowedActions = useMemo(
    () => orderedAllowedActions(state?.allowedActions ?? []),
    [state?.allowedActions],
  );
  const clockRef = useRef<ServerClockSample | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (snapshot) {
      clockRef.current = sampleServerClock(snapshot);
    }
  }, [snapshot, snapshot?.serverTime]);
  useEffect(() => {
    if (typeof state?.deadlineTs !== 'number') return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [state?.deadlineTs]);
  const progress = stageProgress(
    state?.stageStartedAt,
    state?.deadlineTs,
    clockRef.current,
    now,
  );
  const countdown = formatCountdown(
    remainingServerMs(state?.deadlineTs, clockRef.current, now),
  );
  const actionKey = allowedActions.join('|');
  const voteRound = snapshot
    ? currentVoteRoundProjection(snapshot, events, allowedActions)
    : null;
  const draftScopeKey = [
    snapshot?.gameId ?? 'no-game',
    state?.day ?? 0,
    state?.stageRevision ?? 0,
    actionKey,
    voteRound?.key ?? 'no-vote',
  ].join(':');
  const activeAction = isEliminated && !isLastWordsTurn
    ? null
    : actionDraft.activeAction && allowedActions.includes(actionDraft.activeAction)
      ? actionDraft.activeAction
      : allowedActions[0] ?? null;
  const visibleEvents = useMemo(
    () =>
      chatEventsForViewer(events, snapshot?.viewer ?? null)
        .slice(-MAX_EVENT_WINDOW),
    [events, snapshot?.viewer],
  );
  const playerName = useMemo(
    () => createPlayerNameResolver(players, room?.members ?? []),
    [players, room?.members],
  );
  const hasActiveSpeaker =
    (state?.phase === 'day' &&
      (dayStage === 'speech' || dayStage === 'discussion' || dayStage === 'last_words')) ||
    (state?.phase === 'night' && state.nightStage === 'wolf_discussion');
  const currentSpeakerId: string | null = state?.phase === 'night' && state.nightStage === 'wolf_discussion'
    ? state.wolfCurrentSpeaker ?? null
    : state?.currentSpeaker ?? null;
  const currentSpeakerName = hasActiveSpeaker && currentSpeakerId
    ? playerName(currentSpeakerId)
    : null;
  const speakerToneFor = (id: string | null): number => {
    const player = players.find((candidate) => candidate.id === id);
    return player ? Math.max(0, (player.order - 1) % 6) : 0;
  };
  const eventActorId = (event: (typeof visibleEvents)[number]): string | null => {
    const actorId = event.payload?.actorId;
    return typeof actorId === 'string' ? actorId : event.actorId ?? null;
  };
  const isSpeechEvent = (event: (typeof visibleEvents)[number]): boolean =>
    event.eventType === 'day.speech' || event.eventType === 'wolf.message';
  const wolfKillTargetId = myPlayer?.role === 'wolf'
    ? [...visibleEvents]
        .reverse()
        .find((event) => event.eventType === 'wolf.kill_locked')?.payload.targetId
    : undefined;
  const firstAllowedAction = isEliminated && !isLastWordsTurn
    ? null
    : allowedActions[0] ?? null;

  const isRoleConfirmation = state?.phase === 'role_confirm';
  const canConfirmRole = isRoleConfirmation && allowedActions.includes('confirm_role');

  useEffect(() => {
    if (!isRoleConfirmation || !myPlayer?.role) {
      setRoleRevealed(false);
      setRoleInfoOpen(false);
      return undefined;
    }
    setRoleRevealed(false);
    setRoleInfoOpen(false);
    const timer = window.setTimeout(() => setRoleRevealed(true), 520);
    return () => window.clearTimeout(timer);
  }, [isRoleConfirmation, myPlayer?.role]);

  useLayoutEffect(() => {
    setActionDraft({
      activeAction: firstAllowedAction,
      selectedTarget: null,
      message: '',
    });
  }, [draftScopeKey, firstAllowedAction]);

  const definition = activeAction
    ? ACTION_DEFINITIONS[activeAction]
    : null;
  const targets =
    activeAction && snapshot
      ? activeAction === 'vote' && voteRound
        ? voteRound.candidates
        : eligibleTargets(activeAction, snapshot, events, allowedActions)
      : [];
  const selectedTarget =
    actionDraft.activeAction === activeAction &&
    (actionDraft.selectedTarget === null ||
      targets.some((target) => target.id === actionDraft.selectedTarget))
      ? actionDraft.selectedTarget
      : null;
  const message =
    actionDraft.activeAction === activeAction ? actionDraft.message : '';
  const lastWordsSkip =
    activeAction === 'skip_speech' &&
    (state?.phase === 'lastWords' || (state as GameState & { dayStage?: string | null } | null)?.dayStage === 'last_words');
  const showsTextInput = definition?.input === 'text' || lastWordsSkip;
  const notifiedHealTarget = healTargetId(events);
  const resolvedTarget =
    activeAction === 'heal' ? notifiedHealTarget : selectedTarget;
  const canSubmit =
    activeAction !== null &&
    ((definition?.input === 'immediate' && !lastWordsSkip) ||
      (lastWordsSkip && message.trim().length > 0) ||
      (definition?.input === 'text' && message.trim().length > 0) ||
      (definition?.input === 'confirm' &&
        (activeAction === 'confirm_role' || resolvedTarget !== null)) ||
      (definition?.input === 'target' &&
        (resolvedTarget !== null || definition.allowsEmptyTarget === true)));

  const submitAction = async () => {
    if (!activeAction) return;
    const command = buildGameCommand({
      actorId: myId,
      actorRole: myPlayer?.role,
      action: activeAction,
      allowedActions,
      targetId: resolvedTarget,
      content: message,
    });
    if (!command) return;
    if (await dispatch(command)) {
      setActionDraft((current) => ({
        ...current,
        selectedTarget: null,
        message: '',
      }));
    }
  };

  if (!room || !session) {
    return (
      <AppShell title="玩家对局" connected={connected}>
        <Card className="v3-empty-state" aria-live="polite">
          <Shield size={24} />
          <strong>正在恢复对局入口</strong>
          <span>房间身份正在同步，游戏界面会在权限确认后显示。</span>
        </Card>
      </AppShell>
    );
  }

  // A URL is only a view intent. Never render player controls for a
  // spectator identity, even if a stale deep link reaches this component.
  if (room.viewer.kind !== 'player' || session.mode !== 'player') {
    return (
      <AppShell title="玩家对局" connected={connected}>
        <Card className="v3-empty-state">
          <Shield size={24} />
          <strong>当前身份不是玩家席</strong>
          <span>请从房间授权的观看入口进入本局。</span>
        </Card>
      </AppShell>
    );
  }
  if (
    snapshot &&
    (snapshot.viewer.kind !== 'player' ||
      snapshot.viewer.playerId !== session.actorId)
  ) {
    return (
      <AppShell title="玩家对局" connected={connected}>
        <Card className="v3-empty-state">
          <Shield size={24} />
          <strong>玩家投影暂不可用</strong>
          <span>正在等待服务端恢复与你匹配的对局信息。</span>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell
      title={room.code}
      eyebrow="房间码"
      phase={phaseLabel(state)}
      countdown={countdown === '—' ? undefined : countdown}
      progress={progress ?? undefined}
      connected={connected}
    >
      {error ? (
        <div className="v3-alert v3-alert--error">{error}</div>
      ) : null}

      {!snapshot ? (
        <Card className="v3-empty-state">
          <Shield size={24} />
          <strong>正在恢复个性化对局快照</strong>
          <span>页面不会在恢复完成前显示旧房间或旧身份状态。</span>
        </Card>
      ) : (
        <>
          {myPlayer?.role ? (
            <Card className="v3-identity-panel">
              <div className="v3-panel-heading">
                <div>
                  <span>仅你可见</span>
                  <h2>我的身份</h2>
                </div>
                <Badge tone={myPlayer.role === 'wolf' ? 'danger' : 'success'}>
                  {myPlayer.role === 'wolf' ? '狼人阵营' : '好人阵营'}
                </Badge>
              </div>
              {isRoleConfirmation ? (
                <>
                  <RoleRevealCard
                    role={myPlayer.role}
                    faction={myPlayer.role === 'wolf' ? '狼人阵营' : '好人阵营'}
                    factionTone={myPlayer.role === 'wolf' ? 'wolf' : 'village'}
                    description={ROLE_DESCRIPTIONS[myPlayer.role]}
                    revealed={roleRevealed}
                    infoOpen={roleInfoOpen}
                    onReveal={() => setRoleRevealed((current) => !current)}
                    onToggleInfo={() => setRoleInfoOpen((current) => !current)}
                  />
                  <div className="v3-role-confirm">
                    <p className="v3-panel-copy">
                      {canConfirmRole ? '请确认你已查看身份牌；确认后首夜将开始。' : '身份牌已确认，等待其他玩家。'}
                    </p>
                    {canConfirmRole ? (
                      <Button
                        disabled={loading || !roleRevealed}
                        onClick={() => void submitAction()}
                      >
                        <Check size={17} />
                        确认身份
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : (
                <RoleCard
                  role={myPlayer.role}
                  name={ROLE_LABELS[myPlayer.role]}
                  faction={myPlayer.role === 'wolf' ? '狼人阵营' : '好人阵营'}
                  factionTone={myPlayer.role === 'wolf' ? 'wolf' : 'village'}
                  description={ROLE_DESCRIPTIONS[myPlayer.role]}
                />
              )}
            </Card>
          ) : null}
          <MatchShell
          left={
            <Card className="v3-player-panel">
              <div className="v3-panel-heading">
                <div>
                  <span>{players.length} 席</span>
                  <h2>玩家座位</h2>
                </div>
                <Badge tone="success">
                  {players.filter((player) => player.isAlive).length} 人存活
                </Badge>
              </div>
              <div className="v3-player-grid">
                {players.map((player) => {
                  const targetable = targets.some(
                    (target) => target.id === player.id,
                  );
                  return (
                    <button
                      key={player.id}
                      className={`v3-player-seat ${!player.isAlive ? 'is-dead' : ''} ${selectedTarget === player.id ? 'is-selected' : ''} ${hasActiveSpeaker && currentSpeakerId === player.id ? `is-speaking v3-player-seat--speaker-${speakerToneFor(player.id)}` : ''}`}
                      aria-current={hasActiveSpeaker && currentSpeakerId === player.id ? 'true' : undefined}
                      disabled={!targetable}
                      onClick={() =>
                        setActionDraft((current) => ({
                          ...current,
                          selectedTarget: player.id,
                        }))
                      }
                    >
                      <span className="v3-player-seat__number">
                        {player.order.toString().padStart(2, '0')}
                      </span>
                      <span className="v3-player-seat__avatar">
                        <UserRound size={22} />
                      </span>
                      <span className="v3-player-seat__name">
                        <strong>{playerName(player.id)}</strong>
                        {player.isAI ? <span className="v3-ai-label">AI</span> : null}
                      </span>
                      <span className="v3-player-seat__status">
                        {!player.isAlive ? (
                          <Skull size={13} />
                        ) : player.isAI ? (
                          <Bot size={13} />
                        ) : (
                          <Circle size={9} fill="currentColor" />
                        )}
                        {!player.isAlive
                          ? '已出局'
                          : targetable
                            ? '可选择'
                            : player.isAI
                              ? '电脑玩家在线'
                              : '存活'}
                        {player.role && player.id !== myId && myPlayer?.role === 'wolf'
                          ? ` · ${ROLE_LABELS[player.role]}`
                          : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            </Card>
          }
          center={isEliminated && !isLastWordsTurn ? (
            <Card className="v3-action-panel v3-spectator-panel">
              <div className="v3-panel-heading">
                <div>
                  <span>你已离开行动席</span>
                  <h2>观战模式</h2>
                </div>
                <Badge tone="info">只读</Badge>
              </div>
              {currentSpeakerName ? (
                <div
                  className={`v3-current-speaker v3-current-speaker--${speakerToneFor(currentSpeakerId)}`}
                  aria-live="polite"
                >
                  <span className="v3-current-speaker__dot" />
                  正在发言：<strong>{currentSpeakerName}</strong>
                </div>
              ) : null}
              <p className="v3-panel-copy">
                你已出局，当前页面已切换为观战视角。可以继续查看剩余玩家的公开发言、投票和出局结果，但不能提交任何行动。
              </p>
              <div className="v3-inline-note">服务端已关闭你的私密行动与夜间信息权限。</div>
            </Card>
          ) : (
            <Card className="v3-action-panel">
              <div className="v3-panel-heading">
                <div>
                  <span>{isLastWordsTurn ? '票出者专属' : '当前阶段'}</span>
                  <h2>{isLastWordsTurn ? '遗言' : '行动面板'}</h2>
                </div>
                <Badge tone={allowedActions.length ? 'warning' : 'info'}>
                  {allowedActions.length ? '轮到你' : '等待队友'}
                </Badge>
              </div>
              {currentSpeakerName ? (
                <div
                  className={`v3-current-speaker v3-current-speaker--${speakerToneFor(currentSpeakerId)}`}
                  aria-live="polite"
                >
                  <span className="v3-current-speaker__dot" />
                  正在发言：<strong>{currentSpeakerName}</strong>
                </div>
              ) : null}
              {isLastWordsTurn ? (
                <div className="v3-inline-note">
                  仅被投票放逐的玩家可以在此提交遗言；夜间死亡不会进入遗言阶段。
                </div>
              ) : null}

              {allowedActions.length && activeAction !== 'confirm_role' ? (
                <>
                  <div
                    className="v3-action-tabs"
                    role="tablist"
                    aria-label="当前允许行动"
                  >
                    {allowedActions.map((action) => (
                      <button
                        key={action}
                        role="tab"
                        aria-selected={activeAction === action}
                        className={
                          activeAction === action ? 'is-active' : undefined
                        }
                        onClick={() => {
                          setActionDraft({
                            activeAction: action,
                            selectedTarget: null,
                            message: '',
                          });
                        }}
                      >
                        {ACTION_LABELS[action]}
                      </button>
                    ))}
                  </div>
                  <p className="v3-panel-copy">
                    {activeAction ? ACTION_HELP[activeAction] : ''}
                  </p>

                  {showsTextInput ? (
                    <Input
                      value={message}
                      onChange={(event) =>
                        setActionDraft((current) => ({
                          ...current,
                          message: event.target.value,
                        }))
                      }
                      placeholder={
                        lastWordsSkip
                          ? '填写放弃遗言的理由'
                          :
                        activeAction === 'wolf_speak'
                          ? '发送到狼人频道'
                          : '输入本轮公开发言'
                      }
                    />
                  ) : null}

                  {definition?.input === 'target' ? (
                    <div className="v3-target-grid">
                      {definition.allowsEmptyTarget ? (
                        <button
                          className={
                            selectedTarget === null ? 'is-selected' : undefined
                          }
                          onClick={() =>
                            setActionDraft((current) => ({
                              ...current,
                              selectedTarget: null,
                            }))
                          }
                        >
                          <span>--</span>
                          <strong>空刀</strong>
                          {selectedTarget === null ? <Check size={16} /> : null}
                        </button>
                      ) : null}
                      {targets.map((player) => (
                        <button
                          key={player.id}
                          className={
                            selectedTarget === player.id
                              ? 'is-selected'
                              : undefined
                          }
                          onClick={() =>
                            setActionDraft((current) => ({
                              ...current,
                              selectedTarget: player.id,
                            }))
                          }
                        >
                          <span>
                            {player.order.toString().padStart(2, '0')}
                          </span>
                          <strong>{playerName(player.id)}</strong>
                          {selectedTarget === player.id ? (
                            <Check size={16} />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {activeAction === 'heal' ? (
                    <div className="v3-inline-note">
                      {notifiedHealTarget
                        ? `当前刀口：${playerName(notifiedHealTarget)}`
                        : '尚未收到可使用解药的私密刀口通知。'}
                    </div>
                  ) : null}

                  <div className="v3-action-panel__footer">
                    <span>
                      {selectedTarget
                        ? `已选择：${playerName(selectedTarget)}`
                        : activeAction
                          ? ACTION_LABELS[activeAction]
                          : '当前无行动'}
                    </span>
                    <Button
                      disabled={loading || !canSubmit}
                      onClick={() => void submitAction()}
                    >
                      <Check size={17} />
                      确认{activeAction ? ACTION_LABELS[activeAction] : '行动'}
                    </Button>
                  </div>
                </>
              ) : allowedActions.includes('confirm_role') ? (
                <div className="v3-inline-note">
                  身份确认按钮已放在身份牌下方，请先查看卡牌。
                </div>
              ) : (
                <div className="v3-inline-note">
                  当前视角没有可提交的行动，等待服务端推送下一阶段。
                </div>
              )}
            </Card>
          )}
          right={
            <Card className="v3-chat-panel">
              <div className="v3-panel-heading">
                <div>
                  <span>按当前玩家视角过滤</span>
                  <h2>聊天流</h2>
                </div>
                <MessageSquare size={18} />
              </div>
              {currentSpeakerName ? (
                <div
                  className={`v3-current-speaker v3-current-speaker--${speakerToneFor(currentSpeakerId)}`}
                  aria-live="polite"
                >
                  <span className="v3-current-speaker__dot" />
                  正在发言：<strong>{currentSpeakerName}</strong>
                </div>
              ) : null}
              {typeof wolfKillTargetId === 'string' ? (
                <div className="v3-wolf-resolution" role="status" aria-live="polite">
                  今晚狼队袭击目标：<strong>{playerName(wolfKillTargetId)}</strong>
                </div>
              ) : null}
              <div className="v3-chat-list">
                {visibleEvents.length === 0 ? (
                  <div className="v3-inline-note">尚未收到可见事件。</div>
                ) : (
                  visibleEvents.map((event) => {
                    const actorId = eventActorId(event);
                    const speech = isSpeechEvent(event);
                    return (
                      <ChatBubble
                        key={event.eventId}
                        author={
                          speech
                            ? playerName(actorId)
                            : event.visibility === 'wolf_private'
                              ? '狼人频道'
                              : '系统'
                        }
                        time={formatEventTime(event.occurredAt)}
                        variant={
                          event.eventType === 'wolf.message'
                            ? 'wolf'
                            : speech && actorId === myId
                              ? 'self'
                              : speech
                                ? 'other'
                                : 'system'
                        }
                        speakerTone={speech ? speakerToneFor(actorId) : undefined}
                        visibility={event.visibility}
                      >
                        {describeEvent(event, playerName, { viewer: snapshot.viewer })}
                      </ChatBubble>
                    );
                  })
                )}
              </div>
            </Card>
          }
          footer={
            <Card className="v3-self-status">
              <div>
                <span>自身身份</span>
                <strong>
                  <Shield size={17} />
                  {myPlayer?.role
                    ? ROLE_LABELS[myPlayer.role]
                    : '未公开'}
                </strong>
              </div>
              <div>
                <span>存活状态</span>
                <Badge tone={myPlayer?.isAlive ? 'success' : 'danger'}>
                  {myPlayer?.isAlive ? '存活' : '已出局'}
                </Badge>
              </div>
              <div>
                <span>阶段</span>
                <Badge tone="gold">{phaseLabel(state)}</Badge>
              </div>
              <div>
                <span>允许命令</span>
                <strong>
                  {allowedActions
                    .map((action) => ACTION_LABELS[action])
                    .join(' / ') || '无'}
                </strong>
              </div>
            </Card>
          }
          />
        </>
      )}
    </AppShell>
  );
}
