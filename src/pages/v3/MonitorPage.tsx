import { Bot, Eye, EyeOff, List, MessageSquare, Radio, UsersRound } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '../../components/shell/AppShell';
import { MatchShell } from '../../components/shell/MatchShell';
import { MobileMatchNav, type MobileMatchNavItem } from '../../components/shell/MobileMatchNav';
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
import { chatEventsForViewer } from '../../v3/visibility';
import { seatColorClass, seatColorIndex } from '../../v3/seatColors';

type MonitorSeatStatus = 'alive' | 'dead' | 'exiled';
type MonitorMobileSection = 'events' | 'chat' | 'identity' | 'view';

const MONITOR_MOBILE_NAV_ITEMS: readonly MobileMatchNavItem[] = [
  { id: 'events', label: '时间线', icon: List },
  { id: 'chat', label: '聊天', icon: MessageSquare },
  { id: 'identity', label: '身份座位', icon: UsersRound },
  { id: 'view', label: '查看', icon: Eye },
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
  const [mobileSection, setMobileSection] = useState<MonitorMobileSection>('events');
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
  const [visibility, setVisibility] = useState('all');
  const [query, setQuery] = useState('');
  const [flippedPlayers, setFlippedPlayers] = useState<Set<string>>(() => new Set());
  const omniscient =
    session?.mode === 'spectator' &&
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
    .filter((event) => visibility === 'all' || event.visibility === visibility)
    .filter((event) =>
      !query.trim() ||
      describeEvent(event, playerName).toLowerCase().includes(query.trim().toLowerCase()),
    )
    .slice(-MAX_EVENT_WINDOW), [events, visibility, query, playerName]);
  const chatMessages = useMemo(
    () => chatEventsForViewer(events, snapshot?.viewer ?? null)
      .filter((event) => event.eventType === 'day.speech' || event.eventType === 'wolf.message')
      .slice(-MAX_EVENT_WINDOW),
    [events, snapshot?.viewer],
  );
  const playerById = useMemo(
    () => new Map(players.map((player) => [player.id, player])),
    [players],
  );
  const seatStatuses = useMemo(() => {
    const statuses = new Map<string, MonitorSeatStatus>(
      players.map((player) => [player.id, player.isAlive ? 'alive' : 'dead']),
    );
    for (const event of events) {
      const payload = event.payload as Record<string, unknown>;
      if (event.eventType === 'day.exiled' && typeof payload.playerId === 'string') {
        statuses.set(payload.playerId, 'exiled');
      }
      if (event.eventType === 'hunter.shot' && typeof payload.targetId === 'string') {
        statuses.set(payload.targetId, 'dead');
      }
      if (event.eventType === 'night.resolved' && Array.isArray(payload.deaths)) {
        for (const playerId of payload.deaths) {
          if (typeof playerId === 'string') statuses.set(playerId, 'dead');
        }
      }
    }
    return statuses;
  }, [events, players]);

  useEffect(() => {
    setFlippedPlayers(new Set());
  }, [snapshot?.gameId]);

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

  if (!omniscient) {
    return (
      <AppShell title="对局监控" connected={connected}>
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
      <AppShell title="对局监控" connected={connected}>
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
      phase={phaseLabel(snapshot.gameState)}
      countdown={(() => {
        const value = formatCountdown(remainingServerMs(
          snapshot.gameState.deadlineTs,
          clockRef.current,
          now,
        ));
        return value === '—' ? undefined : value;
      })()}
      live
      progress={stageProgress(
        snapshot.gameState.stageStartedAt,
        snapshot.gameState.deadlineTs,
        clockRef.current,
        now,
      ) ?? undefined}
      connected={connected}
    >
      <div className="v3-playback-bar">
        <Badge tone="purple"><Radio size={13} />全知监控</Badge>
        <span className="v3-inline-note">已授权查看完整对局信息</span>
      </div>

      <div className="v3-mobile-match-surface">
      <MobileMatchNav
        items={MONITOR_MOBILE_NAV_ITEMS}
        active={mobileSection}
        onChange={(section) => setMobileSection(section as MonitorMobileSection)}
      />
      <MatchShell
        className="v3-monitor-layout"
        mobileSection={mobileSection}
        left={
          <Card>
            <div className="v3-panel-heading"><div><span>{players.length} 席完整身份</span><h2>身份摘要</h2></div></div>
            <div className="v3-identity-list">
              {players.map((player) => {
                const status = seatStatuses.get(player.id) ?? (player.isAlive ? 'alive' : 'dead');
                return (
                <div key={player.id} className={`v3-monitor-identity-row ${seatColorClass(player.order)} is-${status}`}>
                  <button
                    type="button"
                    className={`v3-monitor-identity-flip${flippedPlayers.has(player.id) ? ' is-flipped' : ''}`}
                    aria-label={`${playerName(player.id)}，${flippedPlayers.has(player.id) ? '收起身份牌' : '翻开身份牌'}`}
                    aria-pressed={flippedPlayers.has(player.id)}
                    onClick={() => togglePlayerIdentity(player.id)}
                  >
                    <span className="v3-monitor-identity-flip__inner">
                      <span className="v3-monitor-identity-flip__face v3-monitor-identity-flip__face--front">
                        <img
                          src={getAvatarAsset(player.isAI ? 'computer' : 'player').src}
                          alt=""
                        />
                      </span>
                      <span className="v3-monitor-identity-flip__face v3-monitor-identity-flip__face--back">
                        {player.role ? <img src={roleAssetMap[player.role].src} alt="" /> : null}
                      </span>
                    </span>
                    <span className={`v3-monitor-identity-flip__status v3-monitor-identity-flip__status--${status}`} aria-label={monitorSeatStatusLabel[status]} />
                  </button>
                  <strong>
                    <span className="v3-numeric">{player.order.toString().padStart(2, '0')}</span>{' '}
                    <span className="v3-monitor-identity-name">{playerName(player.id)}</span>{player.isAI ? <span className="v3-ai-label">AI</span> : null}
                  </strong>
                  <Badge tone={status === 'alive' ? 'success' : status === 'exiled' ? 'neutral' : 'danger'}>{monitorSeatStatusLabel[status]}</Badge>
                  {flippedPlayers.has(player.id) ? (
                    <span className="v3-monitor-identity-role">
                      {player.role ? ROLE_LABELS[player.role] : '身份待分配'}
                    </span>
                  ) : null}
                </div>
                );
              })}
            </div>
            <p className="v3-inline-note">点击座位头像翻开身份牌；身份、夜间私密行动和狼人频道仅在此全知视角显示。</p>
          </Card>
        }
        center={
          <div className="v3-monitor-stream">
            <Card>
              <div className="v3-panel-heading"><div><span>完整对局记录</span><h2>事件时间线</h2></div></div>
              <div className="v3-console-events">
                {filteredEvents.length === 0 ? (
                  <div className="v3-inline-note">当前筛选条件下没有事件。</div>
                ) : filteredEvents.map((event, index) => (
                  <Fragment key={event.eventId}>
                    <DayDivider event={event} previous={filteredEvents[index - 1] ?? null} fallbackDay={snapshot.gameState.day} />
                    <div>
                      <time>{formatEventTime(event.occurredAt)}</time>
                      <Badge tone={
                        event.visibility === 'public_timeline' ? 'gold' :
                        event.visibility === 'wolf_private' ? 'danger' :
                        event.visibility === 'role_private' ? 'purple' : 'info'
                      }>
                        {VISIBILITY_LABELS[event.visibility]}
                      </Badge>
                      <p>{describeEvent(event, playerName, { viewer: snapshot.viewer })}</p>
                    </div>
                  </Fragment>
                ))}
              </div>
            </Card>
            <Card className="v3-monitor-chat">
              <div className="v3-panel-heading">
                <div><span>全知观战聊天</span><h2>发言与狼人频道</h2></div>
                <Badge tone="danger">含狼人频道</Badge>
              </div>
              <div className="v3-chat-list">
                {chatMessages.length === 0 ? (
                  <div className="v3-inline-note">当前还没有发言记录。</div>
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
            </Card>
          </div>
        }
        right={
          <Card>
            <div className="v3-panel-heading"><div><span>对局信息</span><h2>运行摘要</h2></div><Bot size={18} /></div>
            <div className="v3-setting-row">
              <div><strong>房间</strong><span>{room?.code ?? snapshot.roomId}</span></div>
              <Badge tone="success">{room ? roomStatusLabel(room.status) : '对局中'}</Badge>
            </div>
            <div className="v3-setting-row">
              <div><strong>记录数量</strong><span>仅保留最近 {MAX_EVENT_WINDOW} 条，历史记录按页从服务端读取。</span></div>
              <strong>{events.length}</strong>
            </div>
            <details className="v3-advanced-info">
              <summary>高级信息</summary>
              <div className="v3-setting-row">
                <div><strong>阶段版本</strong><span>仅用于行动并发校验，不代表进度。</span></div>
                <strong>{snapshot.gameState.stageRevision ?? 0}</strong>
              </div>
              <div className="v3-setting-row">
                <div><strong>最后事件序号</strong><span>服务端记录游标。</span></div>
                <strong>{snapshot.lastSequence}</strong>
              </div>
            </details>
          </Card>
        }
        footer={
          <details className="v3-advanced-info v3-advanced-info--filters">
            <summary>高级筛选</summary>
            <div className="v3-monitor-filters">
              <label>
                可见范围
                <select value={visibility} onChange={(event) => setVisibility(event.target.value)}>
                  <option value="all">全部记录</option>
                  <option value="public_timeline">公开信息</option>
                  <option value="role_private">角色私密</option>
                  <option value="wolf_private">狼人私密</option>
                  <option value="spectator_omniscient">监控记录</option>
                </select>
              </label>
              <label className="v3-monitor-search">
                事件搜索
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索事件摘要" />
              </label>
            </div>
          </details>
        }
      />
      </div>
    </AppShell>
  );
}
