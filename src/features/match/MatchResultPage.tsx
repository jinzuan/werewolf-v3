import { BookOpen, Circle, Skull, Trophy } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AppShell } from '../../components/shell/AppShell';
import { useV3Store } from '../../stores/v3Store';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import {
  describeEvent,
  formatEventTime,
  ROLE_LABELS,
} from '../../v3/presentation';
import {
  resultDeaths,
  resultPlayers,
  resultWinner,
  reviewEvents,
} from './resultModel';

const winnerLabel = (winner: 'wolf' | 'good' | 'draw' | null): string =>
  winner === 'wolf'
    ? '狼人阵营获胜'
    : winner === 'good'
      ? '好人阵营获胜'
      : winner === 'draw'
        ? '本局平局'
        : '胜负结果待恢复';

export function MatchResultPage() {
  const connected = useV3Store((state) => state.connected);
  const room = useV3Store((state) => state.room);
  const session = useV3Store((state) => state.session);
  const snapshot = useV3Store((state) => state.snapshot);
  const events = useV3Store((state) => state.events);

  if (!room || !session) return null;

  if (room.status !== 'ended') {
    return (
      <AppShell title="结果与复盘" eyebrow={room.name} connected={connected}>
        <Card className="v3-empty-state">
          <BookOpen size={24} />
          <strong>对局尚未结束</strong>
          <span>结束后这里会显示胜负、出局记录和复盘内容。</span>
        </Card>
      </AppShell>
    );
  }

  if (!snapshot) {
    return (
      <AppShell title="结果与复盘" eyebrow={room.name} connected={connected}>
        <Card className="v3-empty-state" aria-live="polite">
          <BookOpen size={24} />
          <strong>正在恢复本局结果</strong>
          <span>请稍候，服务端会恢复与你身份匹配的结果投影。</span>
        </Card>
      </AppShell>
    );
  }

  const projectionMatchesSession = snapshot.viewer.kind === 'player'
    ? session.mode === 'player' && snapshot.viewer.playerId === session.actorId
    : session.mode === 'spectator' &&
      snapshot.viewer.spectatorId === session.actorId &&
      snapshot.viewer.omniscient === room.viewer.omniscient;
  if (!projectionMatchesSession) {
    return (
      <AppShell title="结果与复盘" eyebrow={room.name} connected={connected}>
        <Card className="v3-empty-state">
          <BookOpen size={24} />
          <strong>正在恢复匹配的结果</strong>
          <span>当前结果投影与身份不匹配，已暂停显示。</span>
        </Card>
      </AppShell>
    );
  }

  const players = resultPlayers(snapshot);
  const deaths = resultDeaths(snapshot, events);
  const replay = reviewEvents(events);
  const winner = resultWinner(snapshot, events);
  const playerName = (id: string | null) =>
    players.find((player) => player.id === id)?.name ?? '未知目标';

  return (
    <AppShell title="结果与复盘" eyebrow={room.name} connected={connected}>
      <div className="v3-result-hero">
        <Trophy size={28} aria-hidden="true" />
        <div>
          <span>第 {snapshot.gameState.day} 天结束</span>
          <h1>{winnerLabel(winner)}</h1>
        </div>
        <Badge tone={winner === 'wolf' ? 'danger' : winner === 'good' ? 'success' : 'info'}>
          {winner === 'wolf' ? '狼人胜' : winner === 'good' ? '好人胜' : winner === 'draw' ? '平局' : '待确认'}
        </Badge>
      </div>

      <div className="v3-result-grid">
        <Card>
          <div className="v3-panel-heading">
            <div><span>本局变化</span><h2>死亡记录</h2></div>
            <Skull size={18} />
          </div>
          {deaths.length === 0 ? (
            <p className="v3-inline-note">本局没有记录到出局玩家。</p>
          ) : (
            <div className="v3-summary-list">
              {deaths.map((death) => (
                <div key={`${death.playerId}:${death.sequence}`}>
                  <Skull size={16} />
                  <span>
                    第 {death.day} 天 · {death.name} · {death.reason}
                    {death.role ? ` · ${ROLE_LABELS[death.role]}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <div className="v3-panel-heading">
            <div><span>最终状态</span><h2>玩家结果</h2></div>
            <Circle size={18} />
          </div>
          <div className="v3-identity-list">
            {players.map((player) => (
              <div key={player.id} className={!player.isAlive ? 'is-dead' : undefined}>
                <span className="v3-numeric">{String(player.order).padStart(2, '0')}</span>
                <strong>{player.name}{player.isAI ? ' · 电脑玩家' : ''}</strong>
                <span>{player.role ? ROLE_LABELS[player.role] : '身份未公开'}</span>
                <Badge tone={player.isAlive ? 'success' : 'danger'}>
                  {player.isAlive ? '存活' : '已出局'}
                </Badge>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card>
        <div className="v3-panel-heading">
          <div><span>按本视角可见内容</span><h2>复盘记录</h2></div>
          <Badge tone="info">{replay.length} 条记录</Badge>
        </div>
        {replay.length === 0 ? (
          <p className="v3-inline-note">复盘记录正在恢复，或本局没有可公开的记录。</p>
        ) : (
          <div className="v3-timeline">
            {replay.map((event) => (
              <div key={event.eventId}>
                <time>{formatEventTime(event.occurredAt)}</time>
                <span className="v3-timeline__dot v3-timeline__dot--gold" />
                <div>
                  <strong>{describeEvent(event, playerName)}</strong>
                  <span>对局记录</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="v3-action-panel__footer">
        <span>结果来自服务端结束快照；刷新页面仍可恢复本局。</span>
        <Link to="/lobby"><Button>返回大厅</Button></Link>
      </div>
    </AppShell>
  );
}
