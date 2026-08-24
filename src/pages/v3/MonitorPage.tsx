import { Eye, EyeOff, List, MessageSquare, Radio, UsersRound } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '../../components/shell/AppShell';
import { MatchShell } from '../../components/shell/MatchShell';
import { MobileRoomMeta } from '../../components/shell/MobileRoomMeta';
import { MobileMatchNav, type MobileMatchNavItem } from '../../components/shell/MobileMatchNav';
import { useMobileMatchUnread } from '../../components/shell/useMobileMatchUnread';
import { useV3Store } from '../../stores/v3Store';
import { Badge } from '../../ui/Badge';
import { Card } from '../../ui/Card';
import { DayDivider } from '../../ui/DayDivider';
import { ChatBubble } from '../../ui/ChatBubble';
import { Input } from '../../ui/Input';
import { avatarAssetMap, getAvatarAsset, roleAssetMap } from '../../ui/assetRegistry';
import {
  createPlayerNameResolver,
  describeEvent,
  formatEventTime,
  phaseLabel,
  ROLE_LABELS,
  roomStatusLabel,
  VISIBILITY_LABELS,
} from '../../v3/presentation';
import {
  remainingServerMs,
  sampleServerClock,
  stageProgress,
  type ServerClockSample,
} from '../../v3/serverClock';
import { MAX_EVENT_WINDOW } from '../../v3/eventStream';
import { formatCountdown } from '../../v3/countdown';
import { chatEventsForViewer, isSpeechEvent } from '../../v3/visibility';
import { seatColorClass, seatColorIndex } from '../../v3/seatColors';

type MonitorSeatStatus = 'alive' | 'dead' | 'exiled';
type MonitorMobileSection = 'chat' | 'action' | 'players' | 'events';

const MONITOR_MOBILE_NAV_ITEMS: readonly MobileMatchNavItem[] = [
  { id: 'chat', label: '发言', icon: MessageSquare },
  { id: 'action', label: '运行', icon: Eye },
  { id: 'players', label: '玩家', icon: UsersRound },
  { id: 'events', label: '事件', icon: List },
];

const monitorSeatStatusLabel: Record<MonitorSeatStatus, string> = {
  alive: '存活',
  dead: '已死亡',
  exiled: '流放',
};

export function MonitorPage() {
  const connected = useV3Store((state) => state.connected);
  const session = useV3Store((state) => state.session);
  const room = useV3Store((state) => state.room);
  const snapshot = useV3Store((state) => state.snapshot);
  const events = useV3Store((state) => state.events);
  const [mobileSection, setMobileSection] = useState<MonitorMobileSection>('chat');
  const [visibility, setVisibility] = useState('all');
  const [query, setQuery] = useState('');
  const [flippedPlayers, setFlippedPlayers] = useState<Set<string>>(() => new Set());
  const clockRef = useRef<ServerClockSample | null>(null);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (snapshot) clockRef.current = sampleServerClock(snapshot);
  }, [snapshot, snapshot?.serverTime]);
  useEffect(() => {
    if (typeof snapshot?.gameState.deadlineTs !== 'number') return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [snapshot?.gameState.deadlineTs]);
  useEffect(() => setFlippedPlayers(new Set()), [snapshot?.gameId]);

  const mobileUnreadCounts = useMobileMatchUnread(events, snapshot?.gameId, mobileSection);
  const omniscient = session?.mode === 'spectator' &&
    room?.viewer.kind === 'spectator' &&
    room.viewer.omniscient === true &&
    snapshot?.viewer.kind === 'spectator' &&
    snapshot.viewer.omniscient === true;
  const players = useMemo(() => snapshot?.players ?? [], [snapshot?.players]);
  const playerName = useMemo(
    () => createPlayerNameResolver(players, room?.members ?? []),
    [players, room?.members],
  );
  const filteredEvents = useMemo(() => events
    .filter((event) => event.eventType !== 'game.state_updated')
    .filter((event) => !isSpeechEvent(event))
    .filter((event) => visibility === 'all' || event.visibility === visibility)
    .filter((event) => !query.trim() || describeEvent(event, playerName).toLowerCase().includes(query.trim().toLowerCase()))
    .slice(-MAX_EVENT_WINDOW), [events, visibility, query, playerName]);
  const chatMessages = useMemo(
    () => chatEventsForViewer(events, snapshot?.viewer ?? null).filter(isSpeechEvent).slice(-MAX_EVENT_WINDOW),
    [events, snapshot?.viewer],
  );
  const playerById = useMemo(() => new Map(players.map((player) => [player.id, player])), [players]);
  const seatStatuses = useMemo(() => {
    const statuses = new Map<string, MonitorSeatStatus>(
      players.map((player) => [player.id, player.isAlive ? 'alive' : 'dead']),
    );
    for (const event of events) {
      const payload = event.payload as Record<string, unknown>;
      if (event.eventType === 'day.exiled' && typeof payload.playerId === 'string') statuses.set(payload.playerId, 'exiled');
      if (event.eventType === 'hunter.shot' && typeof payload.targetId === 'string') statuses.set(payload.targetId, 'dead');
      if (event.eventType === 'night.resolved' && Array.isArray(payload.deaths)) {
        for (const playerId of payload.deaths) {
          if (typeof playerId === 'string') statuses.set(playerId, 'dead');
        }
      }
    }
    return statuses;
  }, [events, players]);

  const currentSpeakerId = snapshot?.gameState.wolfCurrentSpeaker ??
    snapshot?.gameState.currentSpeaker ??
    snapshot?.gameState.allowedActors?.[0]?.playerId ??
    null;
  const currentSpeakerName = currentSpeakerId ? playerName(currentSpeakerId) : null;
  const speakerOrder = snapshot?.gameState.wolfSpeakerOrder?.length
    ? snapshot.gameState.wolfSpeakerOrder
    : snapshot?.gameState.speakerOrder ?? [];
  const currentSpeakerIndex = currentSpeakerId ? speakerOrder.indexOf(currentSpeakerId) : -1;
  const nextSpeakerId = currentSpeakerIndex >= 0
    ? speakerOrder[currentSpeakerIndex + 1] ?? null
    : speakerOrder[0] ?? null;
  const nextSpeakerName = nextSpeakerId ? playerName(nextSpeakerId) : null;
  const aliveCount = players.filter((player) => player.isAlive).length;
  const stageTitle = snapshot ? phaseLabel(snapshot.gameState) : '恢复中';
  const countdown = snapshot
    ? formatCountdown(remainingServerMs(snapshot.gameState.deadlineTs, clockRef.current, now))
    : '—';

  const togglePlayerIdentity = (playerId: string): void => {
    setFlippedPlayers((current) => {
      const next = new Set(current);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
  };
  const eventActorId = (event: (typeof chatMessages)[number]): string | null => {
    const actorId = event.payload?.actorId;
    return typeof actorId === 'string' ? actorId : event.actorId ?? null;
  };
  const renderEvents = (items: typeof filteredEvents) => items.length === 0 ? (
    <div className="v3-inline-note">当前筛选条件下没有事件。</div>
  ) : items.map((event, index) => (
    <Fragment key={event.eventId}>
      <DayDivider event={event} previous={items[index - 1] ?? null} fallbackDay={snapshot?.gameState.day ?? 1} />
      <div className="v3-event-item">
        <div className="v3-event-item__meta">
          <time>{formatEventTime(event.occurredAt)}</time>
          <Badge tone={
            event.visibility === 'public_timeline' ? 'gold' :
            event.visibility === 'wolf_private' ? 'danger' :
            event.visibility === 'role_private' ? 'purple' : 'info'
          }>{VISIBILITY_LABELS[event.visibility]}</Badge>
        </div>
        <p>{describeEvent(event, playerName, { viewer: snapshot?.viewer })}</p>
      </div>
    </Fragment>
  ));

  if (!omniscient) {
    return (
      <AppShell title="对局监控" connected={connected} pageClassName="v3-page--match">
        <Card className="v3-empty-state">
          <EyeOff size={24} />
          <strong>当前会话没有全知观战授权</strong>
          <span>监控页不会根据公开信息猜测身份，也不会展示未授权内容。</span>
        </Card>
      </AppShell>
    );
  }
  if (!snapshot) {
    return (
      <AppShell title="对局监控" connected={connected} pageClassName="v3-page--match">
        <Card className="v3-empty-state">
          <Radio size={24} />
          <strong>正在恢复监控信息</strong>
          <span>请稍候，完整对局记录会从服务端恢复。</span>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell
      title={room?.name ?? '快速电脑局'}
      eyebrow="对局监控"
      pageClassName="v3-page--match"
      phase={stageTitle}
      countdown={countdown === '—' ? undefined : countdown}
      live
      progress={stageProgress(snapshot.gameState.stageStartedAt, snapshot.gameState.deadlineTs, clockRef.current, now) ?? undefined}
      connected={connected}
    >
      <section className="v3-stage-summary" aria-labelledby="current-monitor-stage-title">
        <div>
          <span>当前阶段</span>
          <h1 id="current-monitor-stage-title">{stageTitle}</h1>
        </div>
        <div className="v3-stage-summary__turn" aria-live="polite">
          <span>当前轮到</span>
          <strong>{currentSpeakerName ?? '等待阶段推进'}</strong>
        </div>
        <div className="v3-stage-summary__action">
          <span>全知视角</span>
          <strong>{currentSpeakerName ? `下一位 · ${nextSpeakerName ?? '待定'}` : '自动运行'}</strong>
        </div>
        <div className="v3-stage-summary__notice" role="status">
          <span>运行状态</span>
          <strong>{aliveCount} 人存活 · {chatMessages.length} 条发言 · {filteredEvents.length} 条事件</strong>
        </div>
      </section>

      <div className="v3-mobile-match-surface v3-game-workspace" data-mobile-section={mobileSection}>
        <MobileMatchNav
          items={MONITOR_MOBILE_NAV_ITEMS}
          active={mobileSection}
          unreadCounts={mobileUnreadCounts}
          onChange={(section) => setMobileSection(section as MonitorMobileSection)}
        />
        <MatchShell
          className="v3-game-layout v3-monitor-game-layout"
          desktop
          mobileSection={mobileSection}
          centerAriaLabel="聊天与发言"
          rightAriaLabel="AI运行状态与事件通知"
          left={
            <div className="v3-player-rail">
              <details className="v3-card v3-player-panel" open>
                <summary className="v3-panel-heading v3-collapsible-heading">
                  <div><span>{players.length} 席完整身份</span><h2>玩家座位</h2></div>
                  <Badge tone="success">{aliveCount} 人存活</Badge>
                </summary>
                <div className="v3-player-grid">
                  {players.map((player) => {
                    const status = seatStatuses.get(player.id) ?? (player.isAlive ? 'alive' : 'dead');
                    const flipped = flippedPlayers.has(player.id);
                    return (
                      <button
                        key={player.id}
                        type="button"
                        className={[
                          'v3-player-seat',
                          seatColorClass(player.order),
                          status !== 'alive' ? 'is-dead' : '',
                          currentSpeakerId === player.id ? `is-speaking v3-player-seat--speaker-${seatColorIndex(player.order)}` : '',
                        ].filter(Boolean).join(' ')}
                        aria-pressed={flipped}
                        title={`${playerName(player.id)} · ${monitorSeatStatusLabel[status]} · 点击${flipped ? '收起' : '查看'}身份`}
                        onClick={() => togglePlayerIdentity(player.id)}
                      >
                        <span className="v3-player-seat__number">{player.order.toString().padStart(2, '0')}</span>
                        <span className="v3-player-seat__avatar">
                          <img src={flipped && player.role ? roleAssetMap[player.role].src : getAvatarAsset(player.isAI ? 'computer' : 'player').src} alt="" />
                        </span>
                        <span className="v3-player-seat__name">
                          <strong>{playerName(player.id)}</strong>
                          {player.isAI ? <span className="v3-ai-label">AI</span> : null}
                          <span className="v3-monitor-seat-role">{flipped ? (player.role ? ROLE_LABELS[player.role] : '身份待分配') : '点击翻牌'}</span>
                        </span>
                        <span className="v3-player-seat__status" aria-label={monitorSeatStatusLabel[status]} />
                      </button>
                    );
                  })}
                </div>
              </details>
            </div>
          }
          center={
            <Card className="v3-chat-panel">
              <div className="v3-panel-heading">
                <div><span>全知视角 · 含狼人频道</span><h2>聊天流</h2></div>
                <Badge tone="danger">含私密频道</Badge>
              </div>
              {currentSpeakerName ? (
                <div className={`v3-current-speaker v3-seat-color-${currentSpeakerId ? seatColorIndex(playerById.get(currentSpeakerId)?.order ?? 1) : 0}`} aria-live="polite">
                  <span className="v3-current-speaker__dot" />正在发言：<strong>{currentSpeakerName}</strong>
                </div>
              ) : null}
              <div className="v3-chat-list-wrap">
                <div className="v3-chat-list">
                  {chatMessages.length === 0 ? (
                    <div className="v3-inline-note">还没有发言，AI 开口后会显示在这里。</div>
                  ) : chatMessages.map((event, index) => {
                    const actorId = eventActorId(event);
                    const player = actorId ? playerById.get(actorId) : undefined;
                    return (
                      <Fragment key={event.eventId}>
                        <DayDivider event={event} previous={chatMessages[index - 1] ?? null} fallbackDay={snapshot.gameState.day} />
                        <ChatBubble
                          author={playerName(actorId)}
                          authorRole={player?.role ? ROLE_LABELS[player.role] : '身份未知'}
                          time={formatEventTime(event.occurredAt)}
                          variant={event.eventType === 'wolf.message' ? 'wolf' : 'other'}
                          speakerTone={player ? seatColorIndex(player.order) : undefined}
                          visibility={event.visibility}
                          avatarAsset={player ? getAvatarAsset(player.isAI ? 'computer' : 'player') : avatarAssetMap.spectator}
                        >
                          {describeEvent(event, playerName, { viewer: snapshot.viewer })}
                        </ChatBubble>
                      </Fragment>
                    );
                  })}
                </div>
              </div>
            </Card>
          }
          right={
            <div className="v3-match-side v3-desktop-info-rail">
              <Card className="v3-action-panel v3-mobile-pane-action">
                <div className="v3-panel-heading">
                  <div><span>当前阶段</span><h2>AI 运行面板</h2></div>
                  <Badge tone={currentSpeakerName ? 'warning' : 'info'}>{currentSpeakerName ? '自动推进中' : '等待阶段'}</Badge>
                </div>
                <MobileRoomMeta />
                <div className="v3-discussion-queue">
                  <div className="v3-discussion-queue__heading"><strong>发言状态</strong><span>{stageTitle}</span></div>
                  <span>当前：<strong>{currentSpeakerName ?? '暂无'}</strong></span>
                  <span>下一位：<strong>{nextSpeakerName ?? '暂无'}</strong></span>
                  <span>待行动角色：{snapshot.gameState.allowedActors?.length ?? 0} 人</span>
                </div>
                <div className="v3-setting-row">
                  <div><strong>房间</strong><span>{room?.code ?? snapshot.roomId}</span></div>
                  <Badge tone="success">{room ? roomStatusLabel(room.status) : '对局中'}</Badge>
                </div>
                <div className="v3-setting-row">
                  <div><strong>记录数量</strong><span>最近 {MAX_EVENT_WINDOW} 条</span></div>
                  <strong>{events.length}</strong>
                </div>
                <details className="v3-advanced-info">
                  <summary>事件筛选</summary>
                  <div className="v3-monitor-filters">
                    <label>可见范围<select value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="all">全部记录</option><option value="public_timeline">公开信息</option><option value="role_private">角色私密</option><option value="wolf_private">狼人私密</option><option value="spectator_omniscient">监控记录</option></select></label>
                    <label className="v3-monitor-search">事件搜索<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索事件摘要" /></label>
                  </div>
                </details>
              </Card>
              <section className="v3-event-details v3-mobile-pane-events">
                <div className="v3-event-details__summary">
                  <span>事件与系统通知</span>
                  <span className="v3-event-counts"><Badge tone="info">{filteredEvents.length}</Badge></span>
                </div>
                <div className="v3-event-list v3-event-list--desktop">{renderEvents(filteredEvents)}</div>
                <div className="v3-event-list v3-event-list--mobile">{renderEvents(filteredEvents)}</div>
              </section>
            </div>
          }
        />
      </div>
    </AppShell>
  );
}
