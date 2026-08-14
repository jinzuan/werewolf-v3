import { Eye, Radio, ShieldQuestion } from 'lucide-react';
import { useMemo } from 'react';
import { AppShell } from '../../components/shell/AppShell';
import { MatchShell } from '../../components/shell/MatchShell';
import { useV3Store } from '../../stores/v3Store';
import { Badge } from '../../ui/Badge';
import { Card } from '../../ui/Card';
import {
  describeEvent,
  formatEventTime,
  phaseLabel,
  VISIBILITY_LABELS,
} from '../../v3/presentation';
import { publicSpectatorEvents } from '../../v3/visibility';

export function SpectatePage() {
  const connected = useV3Store((state) => state.connected);
  const session = useV3Store((state) => state.session);
  const room = useV3Store((state) => state.room);
  const snapshot = useV3Store((state) => state.snapshot);
  const events = useV3Store((state) => state.events);
  const publicEvents = useMemo(() => publicSpectatorEvents(events), [events]);
  const players = snapshot?.players ?? [];
  const playerName = (id: string | null) =>
    players.find((player) => player.id === id)?.name ?? '未知目标';

  if (!session || session.mode !== 'spectator' || !snapshot) {
    return (
      <AppShell title="公开观战" connected={connected}>
        <Card className="v3-empty-state">
          <Eye size={24} />
          <strong>尚未进入公开观战</strong>
          <span>请在大厅使用房间码与令牌加入观战席。</span>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="公开观战"
      eyebrow={room ? `${room.name} · ${room.code}` : session.roomCode}
      phase={phaseLabel(snapshot.gameState)}
      live
      progress={Math.min(100, ((snapshot.gameState.stageRevision ?? 1) % 8) * 12.5)}
      connected={connected}
    >
      <div className="v3-playback-bar">
        <Badge tone="info"><Radio size={13} />实时事件流</Badge>
        <span className="v3-inline-note">
          当前视角固定为公开投影；客户端会丢弃所有非 public_timeline 事件。
        </span>
      </div>

      <MatchShell
        className="v3-spectate-layout"
        left={
          <Card>
            <div className="v3-panel-heading">
              <div><span>公开投影</span><h2>座位摘要</h2></div>
              <Badge tone="info"><Eye size={13} />公开视角</Badge>
            </div>
            <div className="v3-summary-list">
              {players.map((player) => (
                <div key={player.id}>
                  <ShieldQuestion size={16} />
                  <span>
                    {player.order.toString().padStart(2, '0')} {player.name} · {player.isAlive ? '存活' : '已出局'}
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
              <div><span>按 sequence 排序</span><h2>公开事件时间线</h2></div>
              <span className="v3-numeric">#{snapshot.lastSequence}</span>
            </div>
            <div className="v3-timeline">
              {publicEvents.length === 0 ? (
                <div className="v3-inline-note">当前还没有公开事件。</div>
              ) : publicEvents.map((event) => (
                <div key={event.eventId}>
                  <time>{formatEventTime(event.occurredAt).slice(0, 5)}</time>
                  <span className="v3-timeline__dot v3-timeline__dot--gold" />
                  <div>
                    <strong>{describeEvent(event, playerName)}</strong>
                    <span>{VISIBILITY_LABELS[event.visibility]} · #{event.sequence}</span>
                  </div>
                </div>
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
              <div><strong>观看模式</strong><span>由服务端 ViewerContext 决定。</span></div>
              <Badge tone="success">公开</Badge>
            </div>
            <div className="v3-setting-row">
              <div><strong>全知授权</strong><span>公开观战入口不使用全知令牌。</span></div>
              <Badge tone="danger">未授权</Badge>
            </div>
            <div className="v3-setting-row">
              <div><strong>已接收事件</strong><span>仅统计过滤后的公开事件。</span></div>
              <strong className="v3-numeric">{publicEvents.length}</strong>
            </div>
          </Card>
        }
      />
    </AppShell>
  );
}
