import {
  Bot,
  Check,
  Circle,
  MessageSquare,
  Shield,
  Skull,
  UserRound,
} from 'lucide-react';
import { useLayoutEffect, useMemo, useState } from 'react';
import type { GameAction } from '../../../shared/types';
import { AppShell } from '../../components/shell/AppShell';
import { MatchShell } from '../../components/shell/MatchShell';
import { useV3Store } from '../../stores/v3Store';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { ChatBubble } from '../../ui/ChatBubble';
import { Input } from '../../ui/Input';
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
  describeEvent,
  formatEventTime,
  phaseLabel,
  ROLE_LABELS,
} from '../../v3/presentation';

const ACTION_HELP: Record<GameAction, string> = {
  guard: '可守自己，不能连续两晚守同一名玩家。',
  check: '选择一名其他存活玩家查验阵营。',
  wolf_speak: '消息仅对当前存活狼人可见。',
  wolf_vote: '可选择任意存活玩家，也可以空刀。',
  heal: '解药只能用于服务端私密通知的当前刀口。',
  poison: '选择一名其他存活玩家使用毒药。',
  skip_night: '放弃当前角色的夜间行动。',
  speak: '向公开时间线提交本轮发言。',
  skip_speech: '跳过当前发言机会。',
  vote: '仅显示本轮服务端规则允许的候选人。',
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
  const startGame = useV3Store((state) => state.startGame);
  const [actionDraft, setActionDraft] = useState<{
    activeAction: GameAction | null;
    selectedTarget: string | null;
    message: string;
  }>({
    activeAction: null,
    selectedTarget: null,
    message: '',
  });

  const state = snapshot?.gameState ?? null;
  const players = snapshot?.players ?? [];
  const myId = session?.actorId ?? '';
  const myPlayer = players.find((player) => player.id === myId);
  const allowedActions = orderedAllowedActions(
    state?.allowedActions ?? room?.viewer.allowedActions ?? [],
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
  const activeAction =
    actionDraft.activeAction &&
    allowedActions.includes(actionDraft.activeAction)
      ? actionDraft.activeAction
      : allowedActions[0] ?? null;
  const visibleEvents = useMemo(
    () =>
      events
        .filter((event) => event.eventType !== 'game.state_updated')
        .slice(-30),
    [events],
  );
  const playerName = (id: string | null) =>
    players.find((player) => player.id === id)?.name ?? '未知目标';

  useLayoutEffect(() => {
    const first = allowedActions[0] ?? null;
    setActionDraft({
      activeAction: first,
      selectedTarget: null,
      message: '',
    });
  }, [draftScopeKey]);

  const waiting = room?.status === 'waiting' && !snapshot;
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
  const notifiedHealTarget = healTargetId(events);
  const resolvedTarget =
    activeAction === 'heal' ? notifiedHealTarget : selectedTarget;
  const canSubmit =
    activeAction !== null &&
    (definition?.input === 'immediate' ||
      (definition?.input === 'text' && message.trim().length > 0) ||
      (definition?.input === 'confirm' && resolvedTarget !== null) ||
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

  if (!room || !session) return null;

  return (
    <AppShell
      title={room.code}
      eyebrow="房间码"
      phase={waiting ? '等待开局' : phaseLabel(state)}
      progress={
        state
          ? Math.min(100, ((state.stageRevision ?? 1) % 8) * 12.5)
          : 0
      }
      connected={connected}
    >
      {error ? (
        <div className="v3-alert v3-alert--error">{error}</div>
      ) : null}

      {waiting ? (
        <Card>
          <div className="v3-panel-heading">
            <div>
              <span>{room.name}</span>
              <h2>等待房间</h2>
            </div>
            <Badge tone="gold">
              {room.members.filter((member) => member.kind === 'player').length}
              {' / '}
              {room.maxPlayers}
            </Badge>
          </div>
          <div className="v3-summary-list">
            {room.members.map((member, index) => (
              <div key={member.id}>
                {member.kind === 'spectator' ? (
                  <Circle size={12} />
                ) : (
                  <UserRound size={16} />
                )}
                <span>
                  {(index + 1).toString().padStart(2, '0')} {member.name}
                  {member.isHost ? ' · 房主' : ''}
                  {member.kind === 'spectator' ? ' · 观战' : ''}
                  {!member.connected ? ' · 离线' : ''}
                </span>
              </div>
            ))}
          </div>
          <div className="v3-action-panel__footer">
            <span>
              {session.credentials.joinToken ? (
                <>
                  邀请令牌：
                  <strong className="v3-token">
                    {session.credentials.joinToken}
                  </strong>
                </>
              ) : (
                '等待房主开始对局'
              )}
            </span>
            {room.viewer.canStart ? (
              <Button
                disabled={loading}
                onClick={() => void startGame()}
              >
                开始对局
              </Button>
            ) : (
              <Badge tone="info">等待房主</Badge>
            )}
          </div>
        </Card>
      ) : !snapshot ? (
        <Card className="v3-empty-state">
          <Shield size={24} />
          <strong>正在恢复个性化对局快照</strong>
          <span>页面不会在恢复完成前显示旧房间或旧身份状态。</span>
        </Card>
      ) : (
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
                      className={`v3-player-seat ${!player.isAlive ? 'is-dead' : ''} ${selectedTarget === player.id ? 'is-selected' : ''}`}
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
                      <strong>{player.name}</strong>
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
                              ? 'AI 在线'
                              : '存活'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </Card>
          }
          center={
            <Card className="v3-action-panel">
              <div className="v3-panel-heading">
                <div>
                  <span>服务端允许命令</span>
                  <h2>行动面板</h2>
                </div>
                <Badge tone={allowedActions.length ? 'warning' : 'info'}>
                  修订 {state?.stageRevision ?? 0}
                </Badge>
              </div>

              {allowedActions.length ? (
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

                  {definition?.input === 'text' ? (
                    <Input
                      value={message}
                      onChange={(event) =>
                        setActionDraft((current) => ({
                          ...current,
                          message: event.target.value,
                        }))
                      }
                      placeholder={
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
                          <strong>{player.name}</strong>
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
              ) : (
                <div className="v3-inline-note">
                  当前视角没有可提交的行动，等待服务端推送下一阶段。
                </div>
              )}
            </Card>
          }
          right={
            <Card className="v3-chat-panel">
              <div className="v3-panel-heading">
                <div>
                  <span>按当前玩家视角过滤</span>
                  <h2>事件流</h2>
                </div>
                <MessageSquare size={18} />
              </div>
              <div className="v3-chat-list">
                {visibleEvents.length === 0 ? (
                  <div className="v3-inline-note">尚未收到可见事件。</div>
                ) : (
                  visibleEvents.map((event) => (
                    <ChatBubble
                      key={event.eventId}
                      author={
                        event.visibility === 'wolf_private'
                          ? '狼人频道'
                          : '系统'
                      }
                      time={formatEventTime(event.occurredAt)}
                      variant={
                        event.visibility === 'wolf_private'
                          ? 'wolf'
                          : 'system'
                      }
                      visibility={event.visibility}
                    >
                      {describeEvent(event, playerName)}
                    </ChatBubble>
                  ))
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
      )}
    </AppShell>
  );
}
