import { Eye, List, MessageSquare, Radio, UsersRound } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '../../components/shell/AppShell';
import { MatchShell } from '../../components/shell/MatchShell';
import { MobileRoomMeta } from '../../components/shell/MobileRoomMeta';
import { MobileMatchNav, type MobileMatchNavItem } from '../../components/shell/MobileMatchNav';
import { useMobileMatchUnread } from '../../components/shell/useMobileMatchUnread';
import { useV3Store } from '../../stores/v3Store';
import { Badge } from '../../ui/Badge';
import { Card } from '../../ui/Card';
import { ChatBubble } from '../../ui/ChatBubble';
import { DayDivider } from '../../ui/DayDivider';
import { avatarAssetMap, getAvatarAsset, roleAssetMap } from '../../ui/assetRegistry';
import {
  createPlayerNameResolver,
  describeEvent,
  formatEventTime,
  phaseLabel,
  ROLE_LABELS,
  VISIBILITY_LABELS,
} from '../../v3/presentation';
import { publicSpectatorEvents } from '../../v3/visibility';
import {
  remainingServerMs,
  sampleServerClock,
  stageProgress,
  type ServerClockSample,
} from '../../v3/serverClock';
import { MAX_EVENT_WINDOW } from '../../v3/eventStream';
import { formatCountdown } from '../../v3/countdown';
import { chatEventsForViewer, isSpeechEvent } from '../../v3/visibility';

type SpectateMobileSection = 'events' | 'chat' | 'identity' | 'view';
type SpectateSeatStatus = 'alive' | 'exiled' | 'night-death';

const SPECTATE_MOBILE_NAV_ITEMS: readonly MobileMatchNavItem[] = [
  { id: 'events', label: '时间线', icon: List },
  { id: 'chat', label: '聊天', icon: MessageSquare },
  { id: 'identity', label: '身份座位', icon: UsersRound },
  { id: 'view', label: '查看', icon: Eye },
];

export function SpectatePage() {
  const connected = useV3Store((state) => state.connected);
  const session = useV3Store((state) => state.session);
  const room = useV3Store((state) => state.room);
  const snapshot = useV3Store((state) => state.snapshot);
  const events = useV3Store((state) => state.events);
  const [mobileSection, setMobileSection] = useState<SpectateMobileSection>('events');
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
  const publicEvents = useMemo(
    () => publicSpectatorEvents(events)
      .filter((event) => !isSpeechEvent(event))
      .slice(-MAX_EVENT_WINDOW),
    [events],
  );
  const publicStreamEvents = useMemo(
    () => publicSpectatorEvents(events).slice(-MAX_EVENT_WINDOW),
    [events],
  );
  const chatMessages = useMemo(
    () => chatEventsForViewer(events, snapshot?.viewer ?? null)
      .filter((event) => event.eventType === 'day.speech')
      .slice(-MAX_EVENT_WINDOW),
    [events, snapshot?.viewer],
  );
  const mobileUnreadCounts = useMobileMatchUnread(
    publicStreamEvents,
    snapshot?.gameId,
    mobileSection,
  );
  const players = useMemo(() => snapshot?.players ?? [], [snapshot?.players]);
  const playerName = useMemo(
    () => createPlayerNameResolver(players, room?.members ?? []),
    [players, room?.members],
  );
  const playerById = useMemo(
    () => new Map(players.map((player) => [player.id, player])),
    [players],
  );

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
  const seatStatuses = useMemo(() => {
    const statuses = new Map<string, SpectateSeatStatus>(
      players.map((player) => [player.id, player.isAlive ? 'alive' : 'exiled']),
    );
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

  const isPublicSpectator =
    session?.mode === 'spectator' &&
    room?.viewer.kind === 'spectator' &&
    room.viewer.omniscient === false &&
    snapshot?.viewer.kind === 'spectator' &&
    snapshot.viewer.omniscient === false;

  if (!isPublicSpectator || !snapshot) {
    return (
      <AppShell title="公开观战" connected={connected}>
        <Card className="v3-empty-state">
          <Eye size={24} />
          <strong>尚未进入公开观战</strong>
          <span>请在大厅使用房间码与邀请口令进入观战席。</span>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="公开观战"
      eyebrow={room ? `${room.name} · ${room.code}` : session.roomCode}
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
        <Badge tone="info"><Radio size={13} />实时事件流</Badge>
        <span className="v3-inline-note">
          你只能看到所有玩家都能得知的公开信息。
        </span>
      </div>

      <div className="v3-mobile-match-surface">
      <MobileMatchNav
        items={SPECTATE_MOBILE_NAV_ITEMS}
        active={mobileSection}
        unreadCounts={mobileUnreadCounts}
        onChange={(section) => setMobileSection(section as SpectateMobileSection)}
      />
      <MatchShell
        className="v3-spectate-layout"
        mobileSection={mobileSection}
        left={
          <Card>
            <div className="v3-panel-heading">
              <div className="v3-panel-heading__identity">
                <img className="v3-spectator-avatar" src={avatarAssetMap.spectator.src} alt={avatarAssetMap.spectator.label} />
                <div><span>公开投影</span><h2>座位摘要</h2></div>
              </div>
              <Badge tone="info"><Eye size={13} />公开视角</Badge>
            </div>
            <div className="v3-spectate-identity-list">
              {players.map((player) => (
                <div
                  key={player.id}
                  className={`v3-spectate-identity v3-spectate-identity--${seatStatuses.get(player.id) ?? 'alive'}`}
                >
                  <button
                    type="button"
                    className={`v3-spectate-identity__flip${flippedPlayers.has(player.id) ? ' is-flipped' : ''}`}
                    aria-label={`${playerName(player.id)}，${flippedPlayers.has(player.id) ? '收起角色牌' : '翻看角色牌'}`}
                    aria-pressed={flippedPlayers.has(player.id)}
                    onClick={() => togglePlayerIdentity(player.id)}
                  >
                    <span className="v3-spectate-identity__flip-inner">
                      <span className="v3-spectate-identity__face v3-spectate-identity__face--front">
                        <img src={getAvatarAsset(player.isAI ? 'computer' : 'player').src} alt="" />
                      </span>
                      <span className="v3-spectate-identity__face v3-spectate-identity__face--back">
                        {player.role ? <img src={roleAssetMap[player.role].src} alt="" /> : <span>?</span>}
                      </span>
                    </span>
                    <span className="v3-spectate-identity__status" aria-label={player.isAlive ? '存活' : '已出局'} />
                  </button>
                  <div className="v3-spectate-identity__copy">
                    <strong>{playerName(player.id)}{player.isAI ? <span className="v3-ai-label">AI</span> : null}</strong>
                    <Badge tone={player.isAlive ? 'success' : 'danger'}>{player.isAlive ? '存活' : '已出局'}</Badge>
                    <span>{flippedPlayers.has(player.id) ? (player.role ? ROLE_LABELS[player.role] : '角色待公开') : '点击头像翻看角色'}</span>
                  </div>
                </div>
              ))}
            </div>
            <p className="v3-inline-note">角色牌与白天公开发言可查看；狼人夜间频道、查验、守护和用药详情不会进入本页。</p>
          </Card>
        }
        center={
          <div className="v3-spectate-stream">
            <Card className="v3-spectate-timeline">
              <div className="v3-panel-heading v3-timeline-heading">
                <div><span>按时间顺序</span><h2>公开事件时间线</h2></div>
                <span className="v3-numeric">最近 {publicEvents.length} 条</span>
              </div>
              <div className="v3-timeline">
                {publicEvents.length === 0 ? (
                  <div className="v3-inline-note">当前还没有公开事件。</div>
                ) : publicEvents.map((event, index) => (
                  <Fragment key={event.eventId}>
                    <DayDivider event={event} previous={publicEvents[index - 1] ?? null} fallbackDay={snapshot.gameState.day} />
                    <div>
                      <time>{formatEventTime(event.occurredAt).slice(0, 5)}</time>
                      <span className="v3-timeline__dot v3-timeline__dot--gold" />
                      <div>
                        <strong>{describeEvent(event, playerName, { viewer: snapshot.viewer })}</strong>
                        <span>{VISIBILITY_LABELS[event.visibility]}</span>
                      </div>
                    </div>
                  </Fragment>
                ))}
              </div>
            </Card>
            <Card className="v3-chat-panel v3-spectate-chat">
              <div className="v3-panel-heading">
                <div><span>仅显示公开发言</span><h2>聊天流</h2></div>
                <MessageSquare size={18} />
              </div>
              <div className="v3-chat-list">
                {chatMessages.length === 0 ? (
                  <div className="v3-inline-note">当前还没有公开发言。</div>
                ) : chatMessages.map((event, index) => {
                  const actorId = eventActorId(event);
                  const player = actorId ? playerById.get(actorId) : undefined;
                  return (
                    <Fragment key={event.eventId}>
                      <DayDivider event={event} previous={chatMessages[index - 1] ?? null} fallbackDay={snapshot.gameState.day} />
                      <ChatBubble
                        author={playerName(actorId)}
                        authorRole={player?.role ? ROLE_LABELS[player.role] : undefined}
                        time={formatEventTime(event.occurredAt)}
                        variant="other"
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
            <div className="v3-panel-heading">
              <div><span>投影状态</span><h2>观战权限</h2></div>
            </div>
            <MobileRoomMeta />
            <div className="v3-setting-row">
              <div><strong>观看模式</strong><span>可查看角色牌、白天聊天、投票和出局结果。</span></div>
              <Badge tone="success">公开</Badge>
            </div>
            <div className="v3-setting-row">
              <div><strong>角色信息</strong><span>每个玩家的角色牌可在左侧点击翻看。</span></div>
              <Badge tone="info">可查看</Badge>
            </div>
            <div className="v3-setting-row">
              <div><strong>私密信息</strong><span>狼人夜间频道、夜间行动、查验、守护和用药详情不会显示。</span></div>
              <Badge tone="danger">未授权</Badge>
            </div>
            <div className="v3-setting-row">
              <div><strong>已接收事件</strong><span>仅统计过滤后的公开事件。</span></div>
              <strong className="v3-numeric">{publicEvents.length}</strong>
            </div>
          </Card>
        }
      />
      </div>
    </AppShell>
  );
}
