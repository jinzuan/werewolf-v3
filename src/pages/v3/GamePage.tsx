import {
  ArrowDown,
  Check,
  Eye,
  List,
  MessageSquare,
  RotateCcw,
  Shield,
  Swords,
  UsersRound,
} from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GameAction, GameState } from '../../../shared/types';
import { AppShell } from '../../components/shell/AppShell';
import { PlayerSeatCard } from '../../components/match/PlayerSeatCard';
import { MatchShell } from '../../components/shell/MatchShell';
import { MobileRoomMeta } from '../../components/shell/MobileRoomMeta';
import { MobileMatchNav, type MobileMatchNavItem } from '../../components/shell/MobileMatchNav';
import { useMobileMatchUnread } from '../../components/shell/useMobileMatchUnread';
import { useV3Store } from '../../stores/v3Store';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { ChatBubble } from '../../ui/ChatBubble';
import { Input } from '../../ui/Input';
import { RoleCard } from '../../ui/RoleCard';
import { RoleRevealCard } from '../../ui/RoleRevealCard';
import { DayDivider } from '../../ui/DayDivider';
import { getAvatarAsset } from '../../ui/assetRegistry';
import {
  ACTION_DEFINITIONS,
  buildGameCommand,
  currentVoteRoundProjection,
  eligibleTargets,
  gameActionsReady,
  healTargetId,
  orderedAllowedActions,
} from '../../v3/actions';
import {
  ACTION_LABELS,
  createPlayerNameResolver,
  DAY_STAGE_LABELS,
  describeEvent,
  formatEventTime,
  phaseLabel,
  ROLE_LABELS,
  NIGHT_STAGE_LABELS,
  visibilityLabel,
} from '../../v3/presentation';
import {
  remainingServerMs,
  sampleServerClock,
  stageProgress,
  type ServerClockSample,
} from '../../v3/serverClock';
import { formatCountdown } from '../../v3/countdown';
import { MAX_EVENT_WINDOW } from '../../v3/eventStream';
import { chatEventsForViewer, isSpeechEvent } from '../../v3/visibility';
import { viewerPlayerId } from '../../v3/session';
import { seatColorIndex } from '../../v3/seatColors';

const ROLE_DESCRIPTIONS = {
  wolf: '夜间与狼人队友讨论并决定袭击目标。',
  seer: '每晚查验一名玩家的阵营。',
  witch: '掌握解药与毒药，在夜间作出选择。',
  hunter: '被放逐或击杀后，可选择开枪带走一人。',
  guardian: '每晚守护一名玩家，阻止当晚袭击。',
  villager: '没有夜间技能，通过发言与投票找出狼人。',
} as const;

type SeatStatus = 'alive' | 'exiled' | 'night-death';
type GameMobileSection = 'chat' | 'events' | 'action' | 'players';
const ACTION_HELP: Record<GameAction, string> = {
  confirm_role: '确认已查看自己的身份牌。',
  guard: '可守自己，不能连续两晚守同一名玩家。',
  check: '选择一名其他存活玩家查验阵营。',
  wolf_speak: '消息仅对当前存活狼人可见。',
  wolf_vote: '可选择任意存活玩家，也可以空刀。',
  heal: '解药只能用于当前夜晚显示的刀口。',
  poison: '选择一名其他存活玩家使用毒药。',
  skip_night: '放弃当前角色的夜间行动。',
  speak: '向公开聊天流提交本轮发言。',
  skip_speech: '白天可直接跳过；遗言阶段若放弃，必须填写理由（例如“懒得说”）。',
  request_speech: '申请进入服务端发言队列，排队顺序对所有玩家一致。',
  vote: '仅显示本轮规则允许的候选人。',
  abstain: '本轮允许弃票。',
  hunter_shoot: '选择一名其他存活玩家开枪。',
  skip_hunter_shot: '放弃猎人开枪。',
};

export function GamePage() {
  const connected = useV3Store((state) => state.connected);
  const loading = useV3Store((state) => state.loading);
  const recovering = useV3Store((state) => state.recovering);
  const syncStatus = useV3Store((state) => state.syncStatus);
  const authorityStatus = useV3Store((state) => state.authorityStatus);
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
  const [voteEditing, setVoteEditing] = useState(false);
  const chatInputRef = useRef<HTMLInputElement | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const timelineListRef = useRef<HTMLDivElement | null>(null);
  const [chatInputFocused, setChatInputFocused] = useState(false);
  const [chatAtBottom, setChatAtBottom] = useState(true);
  const [mobileSection, setMobileSection] = useState<GameMobileSection>('chat');
  const mobileActionKeyRef = useRef('');

  const state = snapshot?.gameState ?? null;
  const currentPhaseLabel = phaseLabel(state);
  const stageTitle = currentPhaseLabel.replace(
    /\s*（第\s*\d+\/\d+\s*轮）$/u,
    '',
  );
  const players = useMemo(() => snapshot?.players ?? [], [snapshot?.players]);
  const myId = viewerPlayerId(snapshot?.viewer) ?? '';
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
  const speechActionAvailable = allowedActions.some((action) =>
    action === 'speak' || action === 'wolf_speak' || action === 'skip_speech',
  );
  const actionTransitionKey = [
    snapshot?.gameId ?? 'no-game',
    state?.day ?? 0,
    state?.stageRevision ?? 0,
    actionKey,
  ].join('|');
  useEffect(() => {
    if (actionTransitionKey === mobileActionKeyRef.current) return;
    mobileActionKeyRef.current = actionTransitionKey;
    if (!actionKey) return;
    setMobileSection(
      allowedActions.includes('confirm_role')
        ? 'players'
        : speechActionAvailable
          ? 'chat'
          : 'action',
    );
  }, [actionKey, actionTransitionKey, allowedActions, speechActionAvailable]);
  const mobileUnreadCounts = useMobileMatchUnread(
    events,
    snapshot?.gameId,
    mobileSection,
  );
  const voteRound = snapshot
    ? currentVoteRoundProjection(snapshot, events, allowedActions)
    : null;
  const actionsSynchronized = gameActionsReady({
    connected,
    recovering,
    syncStatus,
    authorityStatus,
    hasSnapshot: snapshot !== null,
  });
  const voteSubmitted = voteRound?.submitted === true;
  const discussionQueue = state?.discussionQueue ?? [];
  const freeDiscussion = state?.daySpeechMode === 'free_discussion' || dayStage === 'discussion';
  const turnTakingSpeech = state?.phase === 'day' &&
    (dayStage === 'speech' || dayStage === 'discussion');
  const discussionCycle = state?.discussionCycle ?? 1;
  const discussionCyclesRequired = state?.discussionCyclesRequired ?? 2;
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
  const mobileNavItems = useMemo<readonly MobileMatchNavItem[]>(() => [
    { id: 'chat', icon: MessageSquare, label: speechActionAvailable ? '发言' : '聊天' },
    { id: 'events', icon: List, label: '事件' },
    {
      id: 'action',
      icon: Swords,
      label: activeAction && !['speak', 'wolf_speak', 'skip_speech'].includes(activeAction)
        ? ACTION_LABELS[activeAction]
        : '行动',
    },
    { id: 'players', icon: UsersRound, label: '玩家/身份' },
  ], [activeAction, speechActionAvailable]);
  const visibleEvents = useMemo(
    () =>
      chatEventsForViewer(events, snapshot?.viewer ?? null)
        .slice(-MAX_EVENT_WINDOW),
    [events, snapshot?.viewer],
  );
  const latestSeerResult = useMemo(
    () => myPlayer?.role === 'seer'
      ? [...visibleEvents].reverse().find((event) => event.eventType === 'seer.result') ?? null
      : null,
    [myPlayer?.role, visibleEvents],
  );
  const playerName = useMemo(
    () => createPlayerNameResolver(players, room?.members ?? []),
    [players, room?.members],
  );
  const humanPlayerCount = useMemo(
    () => room?.members.filter((member) => member.kind === 'player' && !member.isAI).length ?? 0,
    [room?.members],
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
  const nextDiscussionEntry = discussionQueue.find(
    (entry) => entry.playerId !== currentSpeakerId,
  );
  const speakerToneFor = (id: string | null): number => {
    const player = players.find((candidate) => candidate.id === id);
    return player ? seatColorIndex(player.order) : 0;
  };
  const eventActorId = (event: (typeof visibleEvents)[number]): string | null => {
    const actorId = event.payload?.actorId;
    return typeof actorId === 'string' ? actorId : event.actorId ?? null;
  };
  const seerResultSummary = (event: (typeof visibleEvents)[number]): string => {
    const targetId = typeof event.payload?.targetId === 'string'
      ? event.payload.targetId
      : null;
    const alignment = event.payload?.alignment === 'wolf'
      ? '狼人'
      : event.payload?.alignment === 'good'
        ? '好人'
        : '未知阵营';
    return `昨晚查验${playerName(targetId)}=${alignment}`;
  };
  const seerCheckedAlignment = (playerId: string): 'wolf' | 'good' | undefined =>
    myPlayer?.role === 'seer' ? state?.seerResults?.[playerId] : undefined;
  const chatMessages = useMemo(
    () => visibleEvents.filter(isSpeechEvent),
    [visibleEvents],
  );
  const systemEvents = useMemo(
    () => visibleEvents.filter((event) => !isSpeechEvent(event)),
    [visibleEvents],
  );
  const discussionSpokenPlayerIds = useMemo(() => [...new Set(visibleEvents
    .filter((event) => {
      if (
        event.eventType !== 'day.speech' &&
        event.eventType !== 'day.speech_skipped'
      ) return false;
      if (event.payload.day !== state?.day || event.payload.lastWords === true) return false;
      return freeDiscussion
        ? event.payload.discussion === true && event.payload.discussionRound === discussionCycle
        : event.payload.discussion !== true;
    })
    .map((event) => {
      const id = event.payload.actorId ?? event.actorId;
      return typeof id === 'string' ? id : null;
    })
    .filter((id): id is string => id !== null))], [discussionCycle, freeDiscussion, state?.day, visibleEvents]);
  const mobileTimelineEvents = useMemo(
    () => visibleEvents.filter(
      (event) => event.visibility === 'public_timeline' && !isSpeechEvent(event),
    ),
    [visibleEvents],
  );
  const renderSystemEvents = (items: typeof visibleEvents) => items.length === 0 ? (
    <span className="v3-inline-note">暂无系统通知。</span>
  ) : items.map((event, index) => {
    const actorId = eventActorId(event);
    const actor = players.find((player) => player.id === actorId);
    const actorColorClass = actor ? ` v3-seat-color-${seatColorIndex(actor.order)}` : '';
    const stageName = event.stage
      ? DAY_STAGE_LABELS[event.stage as keyof typeof DAY_STAGE_LABELS] ??
        NIGHT_STAGE_LABELS[event.stage as keyof typeof NIGHT_STAGE_LABELS] ??
        '阶段更新'
      : event.phase === 'role_confirm'
        ? '身份确认'
        : '对局进程';
    return (
      <Fragment key={event.eventId}>
        <DayDivider event={event} previous={items[index - 1] ?? null} fallbackDay={state?.day ?? 1} />
        <div className={`v3-event-item${actorColorClass}`}>
          <div className="v3-event-item__meta">
            <time>{formatEventTime(event.occurredAt)}</time>
            <span>{stageName}</span>
            <span>{actor ? `来源：${playerName(actor.id)}` : '来源：系统'}</span>
            <span>{visibilityLabel(event.visibility)}</span>
          </div>
          <p>{describeEvent(event, playerName, { viewer: snapshot?.viewer ?? undefined })}</p>
        </div>
      </Fragment>
    );
  });
  const seatStatus = useMemo(() => {
    const statuses = new Map<string, SeatStatus>();
    for (const player of players) {
      statuses.set(player.id, player.isAlive ? 'alive' : 'exiled');
    }
    for (const event of events) {
      const payload = event.payload as Record<string, unknown>;
      if (event.eventType === 'day.exiled' && typeof payload.playerId === 'string') {
        statuses.set(payload.playerId, 'exiled');
      }
      if (event.eventType === 'hunter.shot' && typeof payload.targetId === 'string') {
        statuses.set(payload.targetId, 'night-death');
      }
      if (event.eventType === 'night.resolved' && Array.isArray(payload.deaths)) {
        for (const playerId of payload.deaths) {
          if (typeof playerId === 'string') statuses.set(playerId, 'night-death');
        }
      }
    }
    return statuses;
  }, [events, players]);
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

  useEffect(() => {
    setVoteEditing(false);
  }, [voteRound?.key]);

  const definition = activeAction
    ? ACTION_DEFINITIONS[activeAction]
    : null;
  const targets =
    activeAction && snapshot && actionsSynchronized
      ? activeAction === 'vote' && voteRound
        ? voteRound.candidates
        : eligibleTargets(activeAction, snapshot, events, allowedActions)
      : [];
  const selectedTarget =
    actionDraft.activeAction === activeAction &&
    (actionDraft.selectedTarget === null ||
      targets.some((target) => target.id === actionDraft.selectedTarget))
      ? actionDraft.selectedTarget ?? (activeAction === 'vote' ? voteRound?.currentTargetId ?? null : null)
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
    actionsSynchronized &&
    activeAction !== null &&
    ((definition?.input === 'immediate' && !lastWordsSkip) ||
      (lastWordsSkip && message.trim().length > 0) ||
      (definition?.input === 'text' && message.trim().length > 0) ||
      (definition?.input === 'confirm' &&
        (activeAction === 'confirm_role' || resolvedTarget !== null)) ||
      (definition?.input === 'target' &&
        (resolvedTarget !== null || definition.allowsEmptyTarget === true)));

  const autoSkipSpeech =
    humanPlayerCount > 1 &&
    state?.phase === 'day' &&
    (dayStage === 'speech' || dayStage === 'discussion') &&
    currentSpeakerId === myId &&
    allowedActions.includes('skip_speech') &&
    showsTextInput &&
    actionsSynchronized;

  useEffect(() => {
    if (!autoSkipSpeech) return undefined;
    const stageStartedAt = state?.stageStartedAt ?? Date.now();
    const autoSkipAt = stageStartedAt + 10_000;
    const timer = window.setTimeout(() => {
      const inputIsBusy =
        chatInputFocused ||
        document.activeElement === chatInputRef.current ||
        message.trim().length > 0;
      if (inputIsBusy) return;
      const command = buildGameCommand({
        actorId: myId,
        actorRole: myPlayer?.role,
        action: 'skip_speech',
        allowedActions,
        targetId: null,
        content: '',
      });
      if (command) void dispatch(command);
    }, Math.max(0, autoSkipAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [allowedActions, autoSkipSpeech, chatInputFocused, dispatch, message, myId, myPlayer?.role, state?.stageStartedAt]);

  useLayoutEffect(() => {
    if (mobileSection === 'chat') {
      const chatList = chatListRef.current;
      if (chatList) chatList.scrollTop = chatList.scrollHeight;
      setChatAtBottom(true);
    }
    if (mobileSection === 'events') {
      const timelineList = timelineListRef.current;
      if (timelineList) timelineList.scrollTop = timelineList.scrollHeight;
    }
  }, [chatMessages.length, mobileSection, mobileTimelineEvents.length]);

  const updateChatScrollPosition = () => {
    const list = chatListRef.current;
    if (!list) return;
    setChatAtBottom(list.scrollHeight - list.scrollTop - list.clientHeight < 24);
  };

  const returnChatToBottom = () => {
    const list = chatListRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    setChatAtBottom(true);
  };

  const submitAction = async () => {
    if (!activeAction || !actionsSynchronized) return;
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
      if (activeAction === 'vote' || activeAction === 'abstain') {
        setVoteEditing(false);
      }
      setActionDraft((current) => ({
        ...current,
        selectedTarget: null,
        message: '',
      }));
    }
  };

  const avatarForPlayer = (playerId: string | null) => {
    const player = players.find((candidate) => candidate.id === playerId);
    return getAvatarAsset(player?.isAI ? 'computer' : 'player');
  };

  const identityPanel = myPlayer?.role ? (
    <Card className="v3-identity-panel v3-mobile-pane-identity">
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
                disabled={loading || !roleRevealed || !actionsSynchronized}
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
  ) : null;

  if (!room || !session) {
    const credentialsInvalid = authorityStatus === 'unauthorized' &&
      !recovering &&
      syncStatus !== 'syncing' &&
      Boolean(error);
    return (
      <AppShell title="玩家对局" connected={connected}>
        <Card className="v3-empty-state" aria-live="polite">
          <Shield size={24} />
          <strong>{credentialsInvalid ? '需要重新进入房间' : '正在恢复对局入口'}</strong>
          <span>
            {credentialsInvalid
              ? '服务端已确认当前身份凭据无效或席位不存在，请返回大厅后重新进入。'
              : '房间身份正在同步，游戏界面会在权限确认后显示。'}
          </span>
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
      pageClassName="v3-page--match"
      phase={currentPhaseLabel}
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
          <section className="v3-stage-summary" aria-labelledby="current-stage-title">
            <div>
              <span>当前阶段</span>
              <h1 id="current-stage-title">{stageTitle}</h1>
            </div>
            <div className="v3-stage-summary__turn" aria-live="polite">
              <span>当前轮到</span>
              <strong>{currentSpeakerName ?? (allowedActions.length ? '你来操作' : '等待其他玩家')}</strong>
            </div>
            <div className="v3-stage-summary__action">
              <span>你</span>
              <strong>
                {!actionsSynchronized
                  ? '同步中'
                  : allowedActions.length
                    ? activeAction
                      ? `可操作 · ${ACTION_LABELS[activeAction]}`
                      : '可操作'
                    : '等待'}
              </strong>
            </div>
          </section>
          <div
            className="v3-mobile-match-surface v3-game-workspace"
            data-mobile-section={mobileSection}
            data-role-confirmation={isRoleConfirmation ? 'true' : 'false'}
          >
          <MobileMatchNav
            items={mobileNavItems}
            active={mobileSection}
            unreadCounts={mobileUnreadCounts}
            onChange={(section) => setMobileSection(section as GameMobileSection)}
          />
          <MatchShell
          className="v3-game-layout"
          desktop
          mobileSection={mobileSection}
          centerAriaLabel="聊天与发言"
          rightAriaLabel="房间信息、身份与行动"
          left={
            <div className="v3-player-rail">
              {identityPanel}
              <details className="v3-card v3-player-panel" open>
              <summary className="v3-panel-heading v3-collapsible-heading">
                <div>
                  <span>{players.length} 席</span>
                  <h2>玩家座位</h2>
                </div>
                <Badge tone="success">
                  {players.filter((player) => player.isAlive).length} 人存活
                </Badge>
              </summary>
              <div className="v3-player-grid">
                {players.map((player) => {
                  const targetable = targets.some(
                    (target) => target.id === player.id,
                  );
                  const status = seatStatus.get(player.id) ?? 'alive';
                  const playerLabel = playerName(player.id);
                  return (
                    <PlayerSeatCard
                      key={player.id}
                      player={player}
                      label={playerLabel}
                      status={status}
                      targetable={targetable}
                      selected={selectedTarget === player.id}
                      checkedAlignment={seerCheckedAlignment(player.id)}
                      speaking={hasActiveSpeaker && currentSpeakerId === player.id}
                      speakerTone={speakerToneFor(player.id)}
                      onSelect={() =>
                        setActionDraft((current) => ({
                          ...current,
                          selectedTarget: player.id,
                        }))
                      }
                    />
                  );
                })}
              </div>
              </details>
            </div>
          }
          right={
            <div className="v3-match-side v3-desktop-info-rail">
            {isEliminated && !isLastWordsTurn ? (
            <Card className="v3-action-panel v3-spectator-panel v3-mobile-pane-action">
              <div className="v3-panel-heading">
                <div>
                  <span>你已离开行动席</span>
                  <h2>观战模式</h2>
                </div>
                <Badge tone="info">只读</Badge>
              </div>
              <p className="v3-panel-copy">
                你已出局，当前页面已切换为观战视角。可以继续查看剩余玩家的公开发言、投票和出局结果，但不能提交任何行动。
              </p>
              <div className="v3-inline-note">服务端已关闭你的私密行动与夜间信息权限。</div>
            </Card>
          ) : (
            <Card className="v3-action-panel v3-mobile-pane-action">
              <div className="v3-panel-heading">
                <div>
                  <span>{isLastWordsTurn ? '票出者专属' : '当前阶段'}</span>
                  <h2>{isLastWordsTurn ? '遗言' : '行动面板'}</h2>
                </div>
                <Badge tone={allowedActions.length ? 'warning' : 'info'}>
                  {!actionsSynchronized
                    ? '同步中'
                    : currentSpeakerId === myId
                      ? '轮到你'
                      : allowedActions.includes('request_speech')
                        ? '可申请插队'
                        : '等待队友'}
                </Badge>
              </div>
              {latestSeerResult ? (
                <div className="v3-mobile-private-result" role="status" aria-live="polite">
                  <span>预言家私密查验</span>
                  <strong>{seerResultSummary(latestSeerResult)}</strong>
                </div>
              ) : null}
              {turnTakingSpeech ? (
                <div className="v3-discussion-queue" aria-live="polite">
                  <div className="v3-discussion-queue__heading">
                    <strong>发言队列</strong>
                    <span>
                      {freeDiscussion
                        ? `自由讨论 ${discussionCycle}/${discussionCyclesRequired} 轮`
                        : '首轮信息报告'}
                    </span>
                  </div>
                  <span>当前发言者：<strong>{currentSpeakerName ?? '暂无'}</strong></span>
                  <span>
                    已发言：{discussionSpokenPlayerIds.length > 0
                      ? discussionSpokenPlayerIds.map((id) => playerName(id)).join('、')
                      : '暂无'}
                  </span>
                  {discussionQueue.length > 0 ? (
                    <ol className="v3-discussion-queue__list">
                      {discussionQueue.map((entry) => (
                        <li
                          key={`${entry.playerId}:${entry.requestOrder}`}
                          className={`v3-seat-color-${speakerToneFor(entry.playerId)}`}
                        >
                          <span>{entry.position}. {playerName(entry.playerId)}</span>
                          <small>
                            {entry.playerId === currentSpeakerId
                              ? '正在发言'
                              : entry.playerId === myId
                                ? entry.source === 'insert'
                                  ? `你 · 插队后第 ${entry.position} 位`
                                  : `你 · 队列第 ${entry.position} 位`
                                : entry.source === 'insert'
                                  ? '已插队'
                                  : '待发言'}
                          </small>
                        </li>
                      ))}
                    </ol>
                  ) : <span>待发言：暂无</span>}
                  <span>
                    下一位：<strong>{nextDiscussionEntry
                      ? playerName(nextDiscussionEntry.playerId)
                      : '暂无'}</strong>
                  </span>
                </div>
              ) : null}
              {voteSubmitted && voteRound ? (
                <div
                  className={`v3-vote-status${voteRound.currentTargetId ? ` v3-seat-color-${speakerToneFor(voteRound.currentTargetId)}` : ''}`}
                  role="status"
                  aria-live="polite"
                >
                  <strong>
                    {voteRound.currentTargetId
                      ? `已投给：${players.find((player) => player.id === voteRound.currentTargetId)?.order ?? '?'}号 · ${playerName(voteRound.currentTargetId)}`
                      : '已弃票'}
                  </strong>
                  <span>投票完成，等待其他玩家投票</span>
                  <span>已投票人数 / 当前存活人数：{voteRound.submittedCount} / {voteRound.totalVoters}</span>
                  {voteEditing ? <span>正在更改当前票，新目标将以服务端确认为准。</span> : null}
                </div>
              ) : null}
              {isLastWordsTurn ? (
                <div className="v3-inline-note">
                  仅被投票放逐的玩家可以在此提交遗言；夜间死亡不会进入遗言阶段。
                </div>
              ) : null}

              {voteSubmitted && !voteEditing ? (
                <Button
                  variant="secondary"
                  disabled={loading || !actionsSynchronized}
                  onClick={() => {
                    setVoteEditing(true);
                    setActionDraft({
                      activeAction: 'vote',
                      selectedTarget: voteRound?.currentTargetId ?? null,
                      message: '',
                    });
                  }}
                >
                  <RotateCcw size={16} />更改投票
                </Button>
              ) : allowedActions.length && activeAction !== 'confirm_role' ? (
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
                        disabled={loading || !actionsSynchronized}
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
                    {activeAction === 'wolf_speak' && state?.nightStage === 'wolf_discussion'
                      ? `狼人第 ${state.wolfDiscussionRound ?? 1}/2 轮讨论：${state.wolfDiscussionRound === 2 ? '确认或纠偏首轮目标。' : '先提出目标与理由。'}`
                      : activeAction ? ACTION_HELP[activeAction] : ''}
                  </p>

                  {definition?.input === 'target' ? (
                    <div className="v3-target-grid">
                      {definition.allowsEmptyTarget ? (
                        <button
                          disabled={loading || !actionsSynchronized}
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
                          disabled={loading || !actionsSynchronized}
                          className={`v3-seat-color-${seatColorIndex(player.order)}${selectedTarget === player.id ? ' is-selected' : ''}`}
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
                          {seerCheckedAlignment(player.id) ? (
                            <small className="v3-target-grid__seer-check">
                              已查验·{seerCheckedAlignment(player.id) === 'wolf' ? '狼人' : '好人'}
                            </small>
                          ) : null}
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

                  {showsTextInput ? (
                    <div className="v3-inline-note">发言输入框在中间聊天区，发送后会进入聊天流。</div>
                  ) : (
                    <div className="v3-action-panel__footer">
                      <span>
                        {selectedTarget
                          ? `已选择：${playerName(selectedTarget)}`
                          : activeAction
                            ? ACTION_LABELS[activeAction]
                            : '当前无行动'}
                      </span>
                      <Button
                        className={selectedTarget
                          ? `v3-action-submit--seat v3-seat-color-${speakerToneFor(selectedTarget)}`
                          : undefined}
                        disabled={loading || !canSubmit || (voteSubmitted && !voteEditing)}
                        onClick={() => void submitAction()}
                      >
                        <Check size={17} />
                        {activeAction === 'vote' && voteRound?.submitted
                          ? '确认修改投票'
                          : activeAction === 'request_speech'
                            ? '申请插队'
                            : `确认${activeAction ? ACTION_LABELS[activeAction] : '行动'}`}
                      </Button>
                    </div>
                  )}
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
          {typeof wolfKillTargetId === 'string' || latestSeerResult ? (
            <div className="v3-event-private v3-mobile-pane-view" role="status" aria-live="polite">
              {typeof wolfKillTargetId === 'string' ? (
                <span>今晚狼队袭击目标：<strong>{playerName(wolfKillTargetId)}</strong></span>
              ) : null}
              {latestSeerResult ? (
                <span><strong>最近查验：</strong>{describeEvent(latestSeerResult, playerName, { viewer: snapshot.viewer })}</span>
              ) : null}
            </div>
          ) : null}
          <Card className="v3-mobile-only v3-mobile-view-panel">
            <div className="v3-panel-heading">
              <div><span>当前玩家视角</span><h2>查看</h2></div>
              <Eye size={18} />
            </div>
            <MobileRoomMeta />
            <div className="v3-setting-row">
              <div><strong>当前阶段</strong><span>服务端实时状态</span></div>
              <strong>{phaseLabel(state)}</strong>
            </div>
            <div className="v3-setting-row">
              <div><strong>存活席位</strong><span>只显示当前权限允许的信息</span></div>
              <strong>{players.filter((player) => player.isAlive).length} / {players.length}</strong>
            </div>
            <p className="v3-inline-note">身份牌和私密行动只属于你；其他玩家的身份不会在玩家视角展开。</p>
          </Card>
          <section
            className="v3-event-details v3-mobile-pane-events"
          >
            <div className="v3-event-details__summary">
              <span>事件与系统通知</span>
              <span className="v3-event-counts">
                <Badge tone="info" className="v3-event-count--desktop">{systemEvents.length}</Badge>
                <Badge tone="info" className="v3-event-count--mobile">{mobileTimelineEvents.length}</Badge>
              </span>
            </div>
            <div className="v3-event-list v3-event-list--desktop">
              {renderSystemEvents(systemEvents)}
            </div>
            <div ref={timelineListRef} className="v3-event-list v3-event-list--mobile">
              {renderSystemEvents(mobileTimelineEvents)}
            </div>
          </section>
            </div>
          }
          center={
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
                  className={`v3-current-speaker v3-seat-color-${speakerToneFor(currentSpeakerId)}`}
                  aria-live="polite"
                >
                  <span className="v3-current-speaker__dot" />
                  正在发言：<strong>{currentSpeakerName}</strong>
                </div>
              ) : null}
              <div className="v3-chat-list-wrap">
                <div
                  ref={chatListRef}
                  className="v3-chat-list"
                  onScroll={updateChatScrollPosition}
                >
                  {chatMessages.length === 0 ? (
                    <div className="v3-inline-note">还没有发言，等大家开口后会显示在这里。</div>
                  ) : (
                    chatMessages.map((event, index) => {
                      const actorId = eventActorId(event);
                      const speaker = players.find((player) => player.id === actorId);
                      return (
                        <Fragment key={event.eventId}>
                          <DayDivider event={event} previous={chatMessages[index - 1] ?? null} fallbackDay={state?.day ?? 1} />
                          <ChatBubble
                            author={
                              playerName(actorId)
                            }
                            seatNumber={speaker?.order}
                            isAI={speaker?.isAI}
                            playerStatus={actorId ? seatStatus.get(actorId) : undefined}
                            time={formatEventTime(event.occurredAt)}
                            variant={
                              event.eventType === 'wolf.message'
                                ? 'wolf'
                                : actorId === myId
                                  ? 'self'
                                  : 'other'
                            }
                            speakerTone={speaker ? seatColorIndex(speaker.order) : undefined}
                            visibility={event.visibility}
                            avatarAsset={avatarForPlayer(actorId)}
                          >
                            {describeEvent(event, playerName, { viewer: snapshot.viewer })}
                          </ChatBubble>
                        </Fragment>
                      );
                    })
                  )}
                </div>
                {!chatAtBottom && chatMessages.length > 0 ? (
                  <Button
                    type="button"
                    variant="quiet"
                    className="v3-chat-jump"
                    onClick={returnChatToBottom}
                  >
                    <ArrowDown size={16} />回到最新
                  </Button>
                ) : null}
              </div>
              <form
                className="v3-chat-input"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canSubmit) void submitAction();
                }}
              >
                <Input
                  ref={chatInputRef}
                  disabled={!showsTextInput || loading || !actionsSynchronized}
                  aria-label={lastWordsSkip ? '遗言内容' : '发言内容'}
                  value={message}
                  onFocus={() => setChatInputFocused(true)}
                  onBlur={() => setChatInputFocused(false)}
                  onChange={(event) =>
                    setActionDraft((current) => ({
                      ...current,
                      message: event.target.value,
                    }))
                  }
                  placeholder={
                    !showsTextInput
                      ? '当前阶段不能发言'
                      : lastWordsSkip
                        ? '填写放弃遗言的理由'
                        : activeAction === 'wolf_speak'
                          ? '发送到狼人频道'
                          : '输入本轮公开发言'
                  }
                />
                <Button type="submit" disabled={!showsTextInput || loading || !canSubmit || !actionsSynchronized}>
                  <MessageSquare size={17} />发送
                </Button>
              </form>
            </Card>
          }
          />
          </div>
        </>
      )}
    </AppShell>
  );
}
