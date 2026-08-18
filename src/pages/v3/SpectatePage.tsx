import { Eye, List, Radio, ShieldQuestion, UsersRound } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '../../components/shell/AppShell';
import { MatchShell } from '../../components/shell/MatchShell';
import { MobileMatchNav, type MobileMatchNavItem } from '../../components/shell/MobileMatchNav';
import { useV3Store } from '../../stores/v3Store';
import { Badge } from '../../ui/Badge';
import { Card } from '../../ui/Card';
import { DayDivider } from '../../ui/DayDivider';
import { avatarAssetMap } from '../../ui/assetRegistry';
import {
  createPlayerNameResolver,
  describeEvent,
  formatEventTime,
  phaseLabel,
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

type SpectateMobileSection = 'events' | 'identity' | 'view';

const SPECTATE_MOBILE_NAV_ITEMS: readonly MobileMatchNavItem[] = [
  { id: 'events', label: '时间线', icon: List },
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
    () => publicSpectatorEvents(events).slice(-MAX_EVENT_WINDOW),
    [events],
  );
  const players = useMemo(() => snapshot?.players ?? [], [snapshot?.players]);
  const playerName = useMemo(
    () => createPlayerNameResolver(players, room?.members ?? []),
    [players, room?.members],
  );

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
            <div className="v3-summary-list">
              {players.map((player) => (
                <div key={player.id}>
                  <ShieldQuestion size={16} />
                  <span>
                    {player.order.toString().padStart(2, '0')} {playerName(player.id)}{player.isAI ? <> <span className="v3-ai-label">AI</span></> : null} · {player.isAlive ? '存活' : '已出局'}
                  </span>
                </div>
              ))}
            </div>
            <p className="v3-inline-note">身份字段、狼聊、查验、守护和用药详情不会进入本页。</p>
          </Card>
        }
        center={
          <Card>
            <div className="v3-panel-heading">
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
        }
        right={
          <Card>
            <div className="v3-panel-heading">
              <div><span>投影状态</span><h2>观战权限</h2></div>
            </div>
            <div className="v3-setting-row">
              <div><strong>观看模式</strong><span>当前身份只能查看公开信息。</span></div>
              <Badge tone="success">公开</Badge>
            </div>
            <div className="v3-setting-row">
              <div><strong>私密信息</strong><span>身份、狼人讨论和特殊行动不会显示。</span></div>
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
