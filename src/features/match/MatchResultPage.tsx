import { useEffect } from 'react';
import { BookOpen, Circle, Skull, Trophy } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ReviewDeathCause, ReviewTimelineEntry } from '../../../shared/reviewContract';
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

const deathCauseLabel: Record<ReviewDeathCause, string> = {
  night_kill: '🌙 夜刀',
  vote: '🗳️ 票出',
  poison: '💊 毒杀',
  hunter_shot: '🔫 枪击',
};

const deathTiming = (cause: ReviewDeathCause, day: number): string =>
  cause === 'night_kill' || cause === 'poison' ? `第${day}夜` : `第${day}天`;

const timelineLabel = (entry: ReviewTimelineEntry): string =>
  entry.summary || '对局事件已记录';

export function MatchResultPage() {
  const connected = useV3Store((state) => state.connected);
  const room = useV3Store((state) => state.room);
  const session = useV3Store((state) => state.session);
  const snapshot = useV3Store((state) => state.snapshot);
  const events = useV3Store((state) => state.events);
  const review = useV3Store((state) => state.review);
  const refreshReview = useV3Store((state) => state.refreshReview);
  const clearReviewInsights = useV3Store((state) => state.clearReviewInsights);

  useEffect(() => {
    if (room?.status !== 'ended') return undefined;
    void refreshReview();
    const timer = window.setInterval(() => {
      const current = useV3Store.getState().review;
      if (current?.status === 'completed' || current?.status === 'disabled' || current?.status === 'failed') return;
      void refreshReview();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [refreshReview, room?.status]);

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
          <span>请稍候，正在恢复与你身份匹配的对局结果。</span>
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

  const godReview = review?.omniscient === true ? review : null;
  const godView = godReview !== null;
  const players = godReview?.players ?? resultPlayers(snapshot);
  const deaths = godReview?.deaths ?? resultDeaths(snapshot, events);
  const replay = reviewEvents(events);
  const winner = resultWinner(snapshot, events);
  const playerName = (id: string | null) =>
    players.find((player) => player.id === id)?.name ?? '未知目标';
  const reviewMessages = review?.messages ?? [];
  const reviewInsights = review?.insights ?? [];
  const teamMessages = reviewMessages.filter((message) => (message.round ?? 'global') === 'team');
  const globalMessages = reviewMessages.filter((message) => (message.round ?? 'global') === 'global');
  const selfMessages = reviewMessages.filter((message) => message.round === 'self');
  const teamInsights = reviewInsights.filter((insight) => (insight.round ?? 'team') === 'team');
  const selfInsights = reviewInsights.filter((insight) => insight.round === 'self');

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
            <div><span>{godView ? '上帝视角 · 死因已还原' : '本局变化'}</span><h2>死亡记录</h2></div>
            <Skull size={18} />
          </div>
          {deaths.length === 0 ? (
            <p className="v3-inline-note">本局没有记录到出局玩家。</p>
          ) : (
            <div className="v3-summary-list v3-result-deaths">
              {deaths.map((death) => (
                <div key={`${death.playerId}:${death.sequence}`}>
                  <Skull size={16} />
                  <span>
                    {'cause' in death
                      ? `${deathTiming(death.cause, death.day)} · ${deathCauseLabel[death.cause]} · ${death.name}`
                      : `第 ${death.day} 天 · ${death.name} · ${death.reason}`}
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
                <strong>{player.name}{player.isAI ? <> <span className="v3-ai-label">AI</span></> : null}</strong>
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
          <div><span>{godView ? '上帝视角 · 所有行动与投票' : '按本视角可见内容'}</span><h2>对局时间线</h2></div>
          <Badge tone="info">{godReview ? godReview.timeline.length : replay.length} 条记录</Badge>
        </div>
        {godReview && godReview.timeline.length > 0 ? (
          <div className="v3-timeline v3-result-timeline">
            {godReview.timeline.map((event) => (
              <div key={event.eventId}>
                <time>{formatEventTime(event.occurredAt)}</time>
                <span className="v3-timeline__dot v3-timeline__dot--gold" />
                <div>
                  <strong>{timelineLabel(event)}</strong>
                  <span>第 {event.sequence} 条服务端事件 · {event.eventType}</span>
                </div>
              </div>
            ))}
          </div>
        ) : replay.length === 0 ? (
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

      <Card>
        <div className="v3-panel-heading">
          <div><span>服务端复盘管线</span><h2>{review?.generationMode === 'ai' ? 'AI 复盘与心得' : '规则复盘与心得'}</h2></div>
          <Badge tone={review?.status === 'completed' ? 'success' : review?.status === 'failed' ? 'danger' : 'info'}>
            {review?.status === 'completed'
              ? '已完成'
              : review?.status === 'disabled'
                ? '未启用'
                : review?.status === 'failed'
                  ? '处理失败'
                  : '整理中'}
          </Badge>
        </div>
        {!review || review.status === 'pending' || review.status === 'running' ? (
          <p className="v3-inline-note">复盘正在由服务端整理，刷新页面会继续恢复进度。</p>
        ) : review.status === 'disabled' ? (
          <p className="v3-inline-note">本房间未启用局后复盘；服务端仍已保存本局权威时间线。</p>
        ) : review.status === 'failed' ? (
          <p className="v3-inline-note">复盘暂时未完成（{review.errorCode ?? '服务端处理失败'}），本局时间线不受影响。</p>
        ) : review.generationMode === 'ai' && review.messages.length === 0 && review.insights.length === 0 ? (
          <p className="v3-inline-note">未配置 LLM Key，已降级为纯上帝视角复盘；完整身份、行动和死因时间线仍可查看。</p>
        ) : (
          <div className="v3-result-review-sections">
            <section className="v3-result-review-section">
              <div className="v3-panel-heading"><div><span>第一轮</span><h3>阵营团队复盘</h3></div><Badge tone="info">协作与失误</Badge></div>
              <div className="v3-summary-list v3-result-ai-copy">
                {teamMessages.map((message) => <div key={message.id}><BookOpen size={16} /><span>{message.text}</span></div>)}
                {teamInsights.map((insight) => <div key={insight.id}><BookOpen size={16} /><span>{insight.text}</span></div>)}
                {teamMessages.length === 0 && teamInsights.length === 0 && <p className="v3-inline-note">当前视角没有可展示的阵营复盘。</p>}
              </div>
            </section>
            <section className="v3-result-review-section">
              <div className="v3-panel-heading"><div><span>第二轮</span><h3>全局公开复盘</h3></div><Badge tone="info">票型与突破口</Badge></div>
              <div className="v3-summary-list v3-result-ai-copy">
                {globalMessages.map((message) => <div key={message.id}><BookOpen size={16} /><span>{message.text}</span></div>)}
                {globalMessages.length === 0 && <p className="v3-inline-note">当前没有公开复盘结论。</p>}
              </div>
            </section>
            <section className="v3-result-review-section">
              <div className="v3-panel-heading"><div><span>第三轮</span><h3>我的 AI 自我复盘</h3></div><Badge tone="success">只更新自己的经验</Badge></div>
              <div className="v3-summary-list v3-result-ai-copy">
                {selfMessages.map((message) => <div key={message.id}><BookOpen size={16} /><span>{message.text}</span></div>)}
                {selfInsights.map((insight) => <div key={insight.id}><BookOpen size={16} /><span>{insight.text}{insight.experienceUpdate ? ` · 经验更新：${insight.experienceUpdate}` : ''}</span></div>)}
                {selfMessages.length === 0 && selfInsights.length === 0 && <p className="v3-inline-note">当前视角没有可展示的个人复盘。</p>}
              </div>
            </section>
            {reviewMessages.length === 0 && reviewInsights.length === 0 && (
              <p className="v3-inline-note">当前视角没有可展示的复盘结论。</p>
            )}
          </div>
        )}
        {snapshot.viewer.kind === 'player' && review?.status === 'completed' && review.insights.length > 0 && (
          <Button variant="quiet" onClick={() => void clearReviewInsights()}>清除我的角色心得</Button>
        )}
      </Card>

      <div className="v3-action-panel__footer">
        <span>结果已保存；刷新页面仍可恢复本局。</span>
        <Link to="/lobby"><Button>返回大厅</Button></Link>
      </div>
    </AppShell>
  );
}
