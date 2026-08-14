import { Bot, EyeOff, Radio } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '../../components/shell/AppShell';
import { MatchShell } from '../../components/shell/MatchShell';
import { useV3Store } from '../../stores/v3Store';
import { Badge } from '../../ui/Badge';
import { Card } from '../../ui/Card';
import { Input } from '../../ui/Input';
import {
  describeEvent,
  formatEventTime,
  phaseLabel,
  ROLE_LABELS,
  VISIBILITY_LABELS,
} from '../../v3/presentation';
import {
  remainingServerMs,
  sampleServerClock,
  stageProgress,
  type ServerClockSample,
} from '../../v3/serverClock';
import { formatCountdown } from '../../utils/countdown';

export function MonitorPage() {
  const connected = useV3Store((state) => state.connected);
  const room = useV3Store((state) => state.room);
  const snapshot = useV3Store((state) => state.snapshot);
  const events = useV3Store((state) => state.events);
  const clockRef = useRef<ServerClockSample | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (snapshot) clockRef.current = sampleServerClock(snapshot);
  }, [snapshot?.serverTime]);
  useEffect(() => {
    if (typeof snapshot?.gameState.deadlineTs !== 'number') return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [snapshot?.gameState.deadlineTs]);
  const [visibility, setVisibility] = useState('all');
  const [query, setQuery] = useState('');
  const omniscient =
    snapshot?.viewer.kind === 'spectator' && snapshot.viewer.omniscient;
  const players = snapshot?.players ?? [];
  const playerName = (id: string | null) =>
    players.find((player) => player.id === id)?.name ?? '未知目标';
  const filteredEvents = useMemo(() => events
    .filter((event) => event.eventType !== 'game.state_updated')
    .filter((event) => visibility === 'all' || event.visibility === visibility)
    .filter((event) =>
      !query.trim() ||
      describeEvent(event, playerName).toLowerCase().includes(query.trim().toLowerCase()),
    ), [events, visibility, query, players]);

  if (!snapshot || !omniscient) {
    return (
      <AppShell title="AI 监控" connected={connected}>
        <Card className="v3-empty-state">
          <EyeOff size={24} />
          <strong>当前会话没有全知观战授权</strong>
          <span>监控页不会回退到公开快照猜测身份，也不会展示私密事件。</span>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell
      title={room?.name ?? 'AI 快速局'}
      eyebrow="Match Console"
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
        <Badge tone="purple"><Radio size={13} />spectator_omniscient</Badge>
        <span className="v3-numeric">序列 #{snapshot.lastSequence}</span>
      </div>

      <MatchShell
        className="v3-monitor-layout"
        left={
          <Card>
            <div className="v3-panel-heading"><div><span>{players.length} 席全身份</span><h2>身份摘要</h2></div></div>
            <div className="v3-identity-list">
              {players.map((player) => (
                <div key={player.id} className={!player.isAlive ? 'is-dead' : undefined}>
                  <span className="v3-numeric">{player.order.toString().padStart(2, '0')}</span>
                  <strong>{player.role ? ROLE_LABELS[player.role] : '未分配'}</strong>
                  <Badge tone={!player.isAlive ? 'danger' : 'success'}>{player.isAlive ? 'alive' : 'dead'}</Badge>
                </div>
              ))}
            </div>
          </Card>
        }
        center={
          <Card>
            <div className="v3-panel-heading"><div><span>授权事件投影</span><h2>事件时间线</h2></div></div>
            <div className="v3-console-events">
              {filteredEvents.length === 0 ? (
                <div className="v3-inline-note">当前筛选条件下没有事件。</div>
              ) : filteredEvents.map((event) => (
                <div key={event.eventId}>
                  <time>{formatEventTime(event.occurredAt)}</time>
                  <Badge tone={
                    event.visibility === 'public_timeline' ? 'gold' :
                    event.visibility === 'wolf_private' ? 'danger' :
                    event.visibility === 'role_private' ? 'purple' : 'info'
                  }>
                    {VISIBILITY_LABELS[event.visibility]}
                  </Badge>
                  <p>{describeEvent(event, playerName)}</p>
                </div>
              ))}
            </div>
          </Card>
        }
        right={
          <Card>
            <div className="v3-panel-heading"><div><span>契约状态</span><h2>运行摘要</h2></div><Bot size={18} /></div>
            <div className="v3-setting-row">
              <div><strong>房间</strong><span>{room?.code ?? snapshot.roomId}</span></div>
              <Badge tone="success">{room?.status ?? 'playing'}</Badge>
            </div>
            <div className="v3-setting-row">
              <div><strong>阶段修订</strong><span>命令并发控制版本。</span></div>
              <strong>{snapshot.gameState.stageRevision ?? 0}</strong>
            </div>
            <div className="v3-setting-row">
              <div><strong>当前事件</strong><span>已通过服务端授权和客户端过滤。</span></div>
              <strong>{events.length}</strong>
            </div>
          </Card>
        }
        footer={
          <div className="v3-monitor-filters">
            <label>
              可见性
              <select value={visibility} onChange={(event) => setVisibility(event.target.value)}>
                <option value="all">全部</option>
                <option value="public_timeline">公开时间线</option>
                <option value="role_private">角色私密</option>
                <option value="wolf_private">狼人私密</option>
                <option value="spectator_omniscient">全知观战</option>
              </select>
            </label>
            <label className="v3-monitor-search">
              事件搜索
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索事件摘要" />
            </label>
          </div>
        }
      />
    </AppShell>
  );
}
