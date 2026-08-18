import type { DomainEvent, EventVisibility } from '../../shared/events';
import type { Player, Role } from '../../shared/types';

/** Versioned so a room snapshot can be migrated without rebuilding its game. */
export const AI_MEMORY_SCHEMA_VERSION = 1 as const;

export type EvidenceLevel = 'doubt' | 'insufficient' | 'iron';
export type MemoryBoardKind = 'good_evidence' | 'wolf_plan';

export interface BehaviorFeatures {
  speechCount: number;
  skippedSpeechCount: number;
  speechOpportunities: number;
  silenceRate: number;
  contradictionCount: number;
  consistencyScore: number;
  positionChangeCount: number;
  lastSpeechSequence: number | null;
  lastSpeech: string | null;
}

export interface EvidenceRecord {
  id: string;
  subjectId: string;
  kind: 'speech' | 'accusation' | 'vote' | 'role_check' | 'behavior';
  level: EvidenceLevel;
  summary: string;
  sourceEventId: string;
  sourceSequence: number;
  sourceVisibility: EventVisibility;
  actorId?: string;
  contradictsOtherSpeech: boolean;
}

export interface AccusationRecord {
  id: string;
  accuserId: string;
  targetId: string;
  stance: 'wolf' | 'good' | 'pressure' | 'neutral';
  reason: string;
  evidenceLevel: EvidenceLevel;
  sourceEventId: string;
  sourceSequence: number;
  contradictsOtherSpeech: boolean;
}

export interface ContradictionRecord {
  id: string;
  subjectId: string;
  targetId: string;
  previousStance: AccusationRecord['stance'];
  currentStance: AccusationRecord['stance'];
  summary: string;
  sourceEventId: string;
  sourceSequence: number;
}

export interface GoodEvidenceNode {
  playerId: string;
  behavior: BehaviorFeatures;
  accusations: AccusationRecord[];
  evidence: EvidenceRecord[];
  contradictions: ContradictionRecord[];
}

export interface GoodEvidenceBoard {
  schemaVersion: typeof AI_MEMORY_SCHEMA_VERSION;
  kind: 'good_evidence';
  ownerId: string;
  initializedSequence: number;
  updatedSequence: number;
  nodes: Record<string, GoodEvidenceNode>;
  recentReasoning: string[];
}

export interface WolfTargetMemory {
  playerId: string;
  speechCount: number;
  skippedSpeechCount: number;
  speechOpportunities: number;
  silenceRate: number;
  roleExposureSignals: number;
  leadershipSignals: number;
  informationSignals: number;
  coordinationSignals: number;
  threatScore: number;
  priority: 'high' | 'medium' | 'low';
  reasons: string[];
  lastObservedSequence: number | null;
}

export interface WolfPlanMemory {
  text: string;
  sourceSequence: number;
  sourceEventId: string;
}

export interface WolfPlanBoard {
  schemaVersion: typeof AI_MEMORY_SCHEMA_VERSION;
  kind: 'wolf_plan';
  ownerId: string;
  initializedSequence: number;
  updatedSequence: number;
  targets: Record<string, WolfTargetMemory>;
  dayPlans: WolfPlanMemory[];
  nightPlans: WolfPlanMemory[];
  focusTargetId: string | null;
  recentReasoning: string[];
}

export type AIMemoryBoard = GoodEvidenceBoard | WolfPlanBoard;
export type AIMemoryBoards = Record<string, AIMemoryBoard>;

const emptyBehavior = (): BehaviorFeatures => ({
  speechCount: 0,
  skippedSpeechCount: 0,
  speechOpportunities: 0,
  silenceRate: 0,
  contradictionCount: 0,
  consistencyScore: 1,
  positionChangeCount: 0,
  lastSpeechSequence: null,
  lastSpeech: null,
});

const emptyGoodNode = (playerId: string): GoodEvidenceNode => ({
  playerId,
  behavior: emptyBehavior(),
  accusations: [],
  evidence: [],
  contradictions: [],
});

const emptyWolfTarget = (playerId: string): WolfTargetMemory => ({
  playerId,
  speechCount: 0,
  skippedSpeechCount: 0,
  speechOpportunities: 0,
  silenceRate: 0,
  roleExposureSignals: 0,
  leadershipSignals: 0,
  informationSignals: 0,
  coordinationSignals: 0,
  threatScore: 0,
  priority: 'low',
  reasons: [],
  lastObservedSequence: null,
});

const createBoard = (player: Player, sequence: number): AIMemoryBoard => {
  if (player.role === 'wolf') {
    return {
      schemaVersion: AI_MEMORY_SCHEMA_VERSION,
      kind: 'wolf_plan',
      ownerId: player.id,
      initializedSequence: sequence,
      updatedSequence: sequence,
      targets: {},
      dayPlans: [],
      nightPlans: [],
      focusTargetId: null,
      recentReasoning: [],
    };
  }
  return {
    schemaVersion: AI_MEMORY_SCHEMA_VERSION,
    kind: 'good_evidence',
    ownerId: player.id,
    initializedSequence: sequence,
    updatedSequence: sequence,
    nodes: { [player.id]: emptyGoodNode(player.id) },
    recentReasoning: [],
  };
};

export const initializeAIMemoryBoards = (
  players: readonly Player[],
  sequence = 0,
): AIMemoryBoards => {
  const boards: AIMemoryBoards = {};
  for (const player of players) {
    const board = createBoard(player, sequence);
    if (board.kind === 'good_evidence') {
      board.nodes = Object.fromEntries(
        players.map((seat) => [seat.id, emptyGoodNode(seat.id)]),
      );
    } else {
      board.targets = Object.fromEntries(
        players.map((seat) => [seat.id, emptyWolfTarget(seat.id)]),
      );
    }
    boards[player.id] = board;
  }
  return boards;
};

/** Add boards for newly restored seats without disturbing existing memory. */
export const ensureAIMemoryBoards = (
  current: AIMemoryBoards | undefined,
  players: readonly Player[],
  sequence = 0,
): { boards: AIMemoryBoards; changed: boolean } => {
  const boards = structuredClone(current ?? {}) as AIMemoryBoards;
  let changed = current === undefined;
  for (const player of players) {
    const existing = boards[player.id];
    if (!existing || existing.schemaVersion !== AI_MEMORY_SCHEMA_VERSION) {
      boards[player.id] = createBoard(player, sequence);
      changed = true;
    }
    const board = boards[player.id];
    if (board.kind === 'good_evidence') {
      for (const seat of players) {
        if (!board.nodes[seat.id]) {
          board.nodes[seat.id] = emptyGoodNode(seat.id);
          changed = true;
        }
      }
    } else {
      for (const seat of players) {
        if (!board.targets[seat.id]) {
          board.targets[seat.id] = emptyWolfTarget(seat.id);
          changed = true;
        }
      }
    }
  }
  return { boards, changed };
};

const payload = (event: DomainEvent): Record<string, unknown> =>
  event.payload as Record<string, unknown>;

const playerName = (players: readonly Player[], playerId: unknown): string =>
  typeof playerId === 'string'
    ? players.find((player) => player.id === playerId)?.name ?? playerId
    : '未知玩家';

const shortText = (text: string, max = 80): string =>
  Array.from(text.replace(/\s+/gu, ' ').trim()).slice(0, max).join('');

const levelLabel = (level: EvidenceLevel): string =>
  level === 'iron' ? '铁证' : level === 'insufficient' ? '不足' : '存疑';

const sourceVisibility = (event: DomainEvent): EventVisibility => event.visibility;

const isPublicEvent = (event: DomainEvent): boolean =>
  event.visibility === 'public_timeline';

const canBoardSee = (
  board: AIMemoryBoard,
  event: DomainEvent,
  players: readonly Player[],
): boolean => {
  const owner = players.find((player) => player.id === board.ownerId);
  // A dead player's memory freezes at death. This mirrors the event projector's
  // death cutoff and prevents future private wolf chat from leaking on restart.
  if (!owner?.isAlive) return false;
  if (isPublicEvent(event)) return true;
  if (event.visibility === 'wolf_private') {
    return board.kind === 'wolf_plan' &&
      (event.audienceIds === undefined || event.audienceIds.includes(board.ownerId));
  }
  return event.visibility === 'role_private' &&
    (event.audienceIds === undefined || event.audienceIds.includes(board.ownerId));
};

const cap = <T>(items: T[], max: number): void => {
  if (items.length > max) items.splice(0, items.length - max);
};

// Memory is persisted in every state commit. Keep the board useful over a
// long game without letting old evidence turn each AI context into a second
// event log.
const MAX_NODE_EVIDENCE = 12;
const MAX_NODE_ACCUSATIONS = 12;
const MAX_NODE_CONTRADICTIONS = 8;

const evidenceLevelForSpeech = (content: string): EvidenceLevel =>
  /铁证|查验|验出|明确是狼|明确为狼/iu.test(content)
    ? 'insufficient'
    : /票型|改票|站边|归票|逻辑|矛盾|回避|沉默|不说话/iu.test(content)
      ? 'insufficient'
      : 'doubt';

type SpeechStance = AccusationRecord['stance'];

const stanceForSpeech = (content: string): SpeechStance => {
  const accusesWolf = /怀疑|可疑|像狼|狼人|狼坑|投出|出局|归票|冲票|不信|打.*狼/iu.test(content);
  const defendsGood = /好人|金水|银水|保他|相信|信任|不是狼|不太像狼/iu.test(content);
  if (accusesWolf && !defendsGood) return 'wolf';
  if (defendsGood && !accusesWolf) return 'good';
  if (accusesWolf) return 'pressure';
  return 'neutral';
};

const mentionedPlayers = (
  content: string,
  players: readonly Player[],
  actorId: string,
): Player[] =>
  [...players]
    .filter((player) => player.id !== actorId && content.includes(player.name))
    .sort((left, right) => right.name.length - left.name.length);

const addGoodEvidence = (
  node: GoodEvidenceNode,
  evidence: EvidenceRecord,
): void => {
  node.evidence.push(evidence);
  cap(node.evidence, MAX_NODE_EVIDENCE);
};

const addGoodAccusation = (
  board: GoodEvidenceBoard,
  accusation: AccusationRecord,
  players: readonly Player[],
): void => {
  const node = board.nodes[accusation.targetId];
  if (!node) return;
  const previous = node.accusations.at(-1);
  const contradictsOtherSpeech = Boolean(
    previous && previous.accuserId !== accusation.accuserId &&
      previous.stance !== accusation.stance &&
      previous.stance !== 'neutral' && accusation.stance !== 'neutral',
  );
  accusation.contradictsOtherSpeech = contradictsOtherSpeech;
  node.accusations.push(accusation);
  cap(node.accusations, MAX_NODE_ACCUSATIONS);
  if (contradictsOtherSpeech) {
    const conflict: EvidenceRecord = {
      id: `${accusation.id}:conflict`,
      subjectId: accusation.targetId,
      kind: 'behavior',
      level: 'insufficient',
      summary: `${playerName(players, accusation.accuserId)}与其他发言对${playerName(players, accusation.targetId)}的判断相反`,
      sourceEventId: accusation.sourceEventId,
      sourceSequence: accusation.sourceSequence,
      sourceVisibility: 'public_timeline',
      actorId: accusation.accuserId,
      contradictsOtherSpeech: true,
    };
    addGoodEvidence(node, conflict);
  }
};

const addGoodSpeech = (
  board: GoodEvidenceBoard,
  event: DomainEvent,
  players: readonly Player[],
): void => {
  const item = payload(event);
  const actorId = typeof item.actorId === 'string' ? item.actorId : event.actorId;
  const content = typeof item.content === 'string' ? item.content : '';
  if (!actorId || !content || item.lastWords === true) return;
  const actorNode = board.nodes[actorId];
  if (!actorNode) return;
  const stance = stanceForSpeech(content);
  actorNode.behavior.speechCount += 1;
  actorNode.behavior.lastSpeechSequence = event.sequence;
  actorNode.behavior.lastSpeech = shortText(content);
  const mentions = mentionedPlayers(content, players, actorId);
  for (const target of mentions) {
    const targetStance = stance === 'neutral' ? 'neutral' : stance;
    const prior = Object.values(board.nodes)
      .flatMap((node) => node.accusations)
      .reverse()
      .find(
        (record) => record.targetId === target.id && record.accuserId === actorId && record.stance !== 'neutral',
      );
    const changed = Boolean(
      prior && prior.stance !== targetStance && targetStance !== 'neutral',
    );
    if (changed) {
      actorNode.behavior.contradictionCount += 1;
      actorNode.behavior.positionChangeCount += 1;
      const contradiction: ContradictionRecord = {
        id: `${event.eventId}:contradiction:${target.id}`,
        subjectId: actorId,
        targetId: target.id,
        previousStance: prior!.stance,
        currentStance: targetStance,
        summary: `${playerName(players, actorId)}先${prior!.stance === 'wolf' ? '怀疑' : '偏向'}${target.name}，本次却${targetStance === 'wolf' ? '改为怀疑' : '转为偏向'}${target.name}`,
        sourceEventId: event.eventId,
        sourceSequence: event.sequence,
      };
      actorNode.contradictions.push(contradiction);
      cap(actorNode.contradictions, MAX_NODE_CONTRADICTIONS);
      addGoodEvidence(actorNode, {
        id: `${event.eventId}:self-contradiction:${target.id}`,
        subjectId: actorId,
        kind: 'behavior',
        level: 'insufficient',
        summary: contradiction.summary,
        sourceEventId: event.eventId,
        sourceSequence: event.sequence,
        sourceVisibility: sourceVisibility(event),
        actorId,
        contradictsOtherSpeech: true,
      });
    }
    const accusation: AccusationRecord = {
      id: `${event.eventId}:accusation:${target.id}`,
      accuserId: actorId,
      targetId: target.id,
      stance: targetStance,
      reason: shortText(content),
      evidenceLevel: evidenceLevelForSpeech(content),
      sourceEventId: event.eventId,
      sourceSequence: event.sequence,
      contradictsOtherSpeech: false,
    };
    addGoodAccusation(board, accusation, players);
    if (stance !== 'neutral') {
      addGoodEvidence(board.nodes[target.id], {
        id: `${event.eventId}:speech:${target.id}`,
        subjectId: target.id,
        kind: 'speech',
        level: accusation.evidenceLevel,
        summary: `${playerName(players, actorId)}提到${target.name}：${shortText(content, 60)}`,
        sourceEventId: event.eventId,
        sourceSequence: event.sequence,
        sourceVisibility: sourceVisibility(event),
        actorId,
        contradictsOtherSpeech: accusation.contradictsOtherSpeech,
      });
    }
  }
  actorNode.behavior.consistencyScore = Math.max(
    0,
    1 - actorNode.behavior.contradictionCount / Math.max(1, actorNode.behavior.speechCount),
  );
};

const addGoodSpeechSkip = (
  board: GoodEvidenceBoard,
  event: DomainEvent,
): void => {
  const item = payload(event);
  if (item.lastWords === true) return;
  const actorId = typeof item.actorId === 'string' ? item.actorId : event.actorId;
  if (!actorId || !board.nodes[actorId]) return;
  board.nodes[actorId].behavior.skippedSpeechCount += 1;
};

const addSpeechOpportunity = (board: GoodEvidenceBoard, players: readonly Player[]): void => {
  for (const player of players) {
    const node = board.nodes[player.id];
    if (!node || !player.isAlive) continue;
    node.behavior.speechOpportunities += 1;
    node.behavior.silenceRate = Math.max(
      0,
      1 - node.behavior.speechCount / Math.max(1, node.behavior.speechOpportunities),
    );
    const alreadyRecordedSilence = node.evidence.some(
      (item) => item.kind === 'behavior' && item.subjectId === player.id && /沉默度/iu.test(item.summary),
    );
    if (node.behavior.silenceRate >= 0.75 && !alreadyRecordedSilence) {
      addGoodEvidence(node, {
        id: `behavior:${board.updatedSequence}:${player.id}`,
        subjectId: player.id,
        kind: 'behavior',
        level: 'doubt',
        summary: `${player.name}沉默度${Math.round(node.behavior.silenceRate * 100)}%，持续低发言`,
        sourceEventId: `behavior:${board.updatedSequence}`,
        sourceSequence: board.updatedSequence,
        sourceVisibility: 'public_timeline',
        contradictsOtherSpeech: false,
      });
    }
  }
};

const refreshWolfTarget = (target: WolfTargetMemory, playerNameText: string): void => {
  target.silenceRate = Math.max(
    0,
    1 - target.speechCount / Math.max(1, target.speechOpportunities),
  );
  target.threatScore =
    target.roleExposureSignals * 4 +
    target.leadershipSignals * 2 +
    target.informationSignals * 2 +
    target.coordinationSignals;
  target.priority = target.threatScore >= 7 ? 'high' : target.threatScore >= 3 ? 'medium' : 'low';
  const reasons: string[] = [];
  if (target.roleExposureSignals > 0) reasons.push('公开暴露神职/信息位信号');
  if (target.leadershipSignals > 0) reasons.push('带队、归票或投票分析强');
  if (target.informationSignals > 0) reasons.push('持续输出查验/逻辑信息');
  if (target.coordinationSignals > 0) reasons.push('能影响其他人的站边或票型');
  if (target.priority === 'low') {
    reasons.push(`${playerNameText}当前发言/带队威胁低，不是优先刀口`);
  }
  target.reasons = reasons;
};

const addWolfSpeech = (
  board: WolfPlanBoard,
  event: DomainEvent,
  players: readonly Player[],
): void => {
  const item = payload(event);
  const actorId = typeof item.actorId === 'string' ? item.actorId : event.actorId;
  const content = typeof item.content === 'string' ? item.content : '';
  if (!actorId || !content || item.lastWords === true) return;
  const mentioned = mentionedPlayers(content, players, actorId);
  const roleExposed = /预言家|女巫|守卫|猎人|神职|我是.*(?:神|预言家|女巫|守卫|猎人)/iu.test(content);
  const information = /查验|验人|金水|银水|刀口|信息位|逻辑|证据/iu.test(content);
  const leadership = /归票|带队|号召|投票|狼坑|明确投|出局|站边/iu.test(content);
  const speaker = board.targets[actorId];
  if (speaker) {
    speaker.speechCount += 1;
    if (roleExposed) speaker.roleExposureSignals += 1;
    if (information) speaker.informationSignals += 1;
    if (leadership) speaker.leadershipSignals += 1;
    speaker.lastObservedSequence = event.sequence;
    refreshWolfTarget(speaker, playerName(players, actorId));
  }
  for (const target of mentioned) {
    const profile = board.targets[target.id];
    if (!profile) continue;
    if (roleExposed) profile.roleExposureSignals += 1;
    if (information) profile.informationSignals += 1;
    if (leadership) profile.leadershipSignals += 1;
    profile.lastObservedSequence = event.sequence;
    refreshWolfTarget(profile, target.name);
  }
  const top = Object.values(board.targets)
    .filter((target) => target.priority !== 'low')
    .sort((left, right) => right.threatScore - left.threatScore)[0];
  if (top) {
    board.focusTargetId = top.playerId;
    board.dayPlans.push({
      text: `白天计划：围绕${playerName(players, top.playerId)}的${top.reasons[0] ?? '行为变化'}施压，保留低威胁潜水位作为后续票型空间。`,
      sourceSequence: event.sequence,
      sourceEventId: event.eventId,
    });
    cap(board.dayPlans, 8);
  }
};

const addWolfOpportunity = (board: WolfPlanBoard, players: readonly Player[]): void => {
  for (const player of players) {
    const target = board.targets[player.id];
    if (!target || !player.isAlive) continue;
    target.speechOpportunities += 1;
    refreshWolfTarget(target, player.name);
  }
};

const addWolfVoteHistory = (
  board: WolfPlanBoard,
  event: DomainEvent,
  players: readonly Player[],
): void => {
  const item = payload(event);
  if (!Array.isArray(item.voteHistory)) return;
  for (const ballot of item.voteHistory) {
    if (!ballot || typeof ballot !== 'object') continue;
    const record = ballot as Record<string, unknown>;
    const voterId = typeof record.voterId === 'string' ? record.voterId : null;
    const targetId = typeof record.targetId === 'string' ? record.targetId : null;
    if (!voterId || !targetId) continue;
    const target = board.targets[voterId];
    if (!target) continue;
    if (typeof record.reason === 'string' && record.reason.trim()) {
      target.coordinationSignals += 1;
      refreshWolfTarget(target, playerName(players, voterId));
    }
  }
};

const addWolfMessage = (
  board: WolfPlanBoard,
  event: DomainEvent,
): void => {
  const item = payload(event);
  const content = typeof item.content === 'string' ? shortText(item.content, 120) : '';
  if (!content) return;
  board.nightPlans.push({
    text: `狼队讨论计划：${content}`,
    sourceSequence: event.sequence,
    sourceEventId: event.eventId,
  });
  cap(board.nightPlans, 10);
};

const addWolfKill = (
  board: WolfPlanBoard,
  event: DomainEvent,
  players: readonly Player[],
): void => {
  const targetId = payload(event).targetId;
  if (typeof targetId !== 'string' || !board.targets[targetId]) return;
  board.focusTargetId = targetId;
  const target = board.targets[targetId];
  board.nightPlans.push({
    text: `夜晚计划：优先处理${playerName(players, targetId)}（${target.priority}威胁，${target.reasons.join('、') || '暂无足够威胁信号'}）；不把沉默低威胁位当固定刀口。`,
    sourceSequence: event.sequence,
    sourceEventId: event.eventId,
  });
  cap(board.nightPlans, 10);
};

const addPrivateRoleEvidence = (
  board: GoodEvidenceBoard,
  event: DomainEvent,
  players: readonly Player[],
): void => {
  const item = payload(event);
  if (event.eventType !== 'seer.result' || typeof item.targetId !== 'string') return;
  const target = board.nodes[item.targetId];
  if (!target) return;
  const result = item.alignment === 'wolf' ? '狼人' : '好人';
  addGoodEvidence(target, {
    id: `${event.eventId}:role-check`,
    subjectId: item.targetId,
    kind: 'role_check',
    level: 'iron',
    summary: `你的服务端查验：${playerName(players, item.targetId)}为${result}`,
    sourceEventId: event.eventId,
    sourceSequence: event.sequence,
    sourceVisibility: event.visibility,
    actorId: board.ownerId,
    contradictsOtherSpeech: false,
  });
  board.recentReasoning.push(`铁证：查验确认${playerName(players, item.targetId)}为${result}`);
  cap(board.recentReasoning, 8);
};

const updateBoardForEvent = (
  board: AIMemoryBoard,
  event: DomainEvent,
  players: readonly Player[],
): void => {
  if (!canBoardSee(board, event, players)) return;
  board.updatedSequence = Math.max(board.updatedSequence, event.sequence);
  if (board.kind === 'good_evidence') {
    switch (event.eventType) {
      case 'day.started':
        addSpeechOpportunity(board, players);
        break;
      case 'day.speech':
        addGoodSpeech(board, event, players);
        break;
      case 'day.speech_skipped':
        addGoodSpeechSkip(board, event);
        break;
      case 'day.exile_result':
      case 'day.revote_required':
      case 'day.no_exile':
      case 'day.exiled':
        addGoodVoteEvidence(board, event, players);
        break;
      case 'seer.result':
        addPrivateRoleEvidence(board, event, players);
        break;
      default:
        break;
    }
  } else {
    switch (event.eventType) {
      case 'day.started':
        addWolfOpportunity(board, players);
        break;
      case 'day.speech':
        addWolfSpeech(board, event, players);
        break;
      case 'day.speech_skipped': {
        const actorId = payload(event).actorId;
        if (typeof actorId === 'string' && board.targets[actorId]) {
          board.targets[actorId].skippedSpeechCount += 1;
          refreshWolfTarget(board.targets[actorId], playerName(players, actorId));
        }
        break;
      }
      case 'day.exile_result':
      case 'day.revote_required':
      case 'day.no_exile':
      case 'day.exiled':
        addWolfVoteHistory(board, event, players);
        break;
      case 'wolf.message':
        addWolfMessage(board, event);
        break;
      case 'wolf.kill_locked':
        addWolfKill(board, event, players);
        break;
      default:
        break;
    }
  }
};

const addGoodVoteEvidence = (
  board: GoodEvidenceBoard,
  event: DomainEvent,
  players: readonly Player[],
): void => {
  const item = payload(event);
  if (!Array.isArray(item.voteHistory)) return;
  for (const ballot of item.voteHistory) {
    if (!ballot || typeof ballot !== 'object') continue;
    const record = ballot as Record<string, unknown>;
    const voterId = typeof record.voterId === 'string' ? record.voterId : null;
    const targetId = typeof record.targetId === 'string' ? record.targetId : null;
    if (!voterId || !targetId || !board.nodes[targetId]) continue;
    const reason = typeof record.reason === 'string' && record.reason.trim()
      ? record.reason.trim()
      : '公开票型（未提供投票理由）';
    const level: EvidenceLevel = /查验|铁证|验出/iu.test(reason) ? 'iron' : 'insufficient';
    const accusation: AccusationRecord = {
      id: `${event.eventId}:vote:${voterId}:${targetId}`,
      accuserId: voterId,
      targetId,
      stance: 'pressure',
      reason,
      evidenceLevel: level,
      sourceEventId: event.eventId,
      sourceSequence: event.sequence,
      contradictsOtherSpeech: false,
    };
    addGoodAccusation(board, accusation, players);
    addGoodEvidence(board.nodes[targetId], {
      id: `${event.eventId}:vote-evidence:${voterId}:${targetId}`,
      subjectId: targetId,
      kind: 'vote',
      level,
      summary: `${playerName(players, voterId)}投给${playerName(players, targetId)}：${shortText(reason, 50)}`,
      sourceEventId: event.eventId,
      sourceSequence: event.sequence,
      sourceVisibility: event.visibility,
      actorId: voterId,
      contradictsOtherSpeech: false,
    });
  }
};

/**
 * Mutates only the cloned board map supplied by the session. GameSession calls
 * this inside its command queue, before appending the state commit marker.
 */
export const updateAIMemoryBoards = (
  current: AIMemoryBoards,
  events: readonly DomainEvent[],
  players: readonly Player[],
): AIMemoryBoards => {
  // GameSession already snapshots the whole transaction before calling this
  // function. Mutating that transaction-local board avoids a second 12-seat
  // deep clone on every speech while retaining rollback safety on append fail.
  const boards = current;
  for (const event of events) {
    for (const board of Object.values(boards)) {
      updateBoardForEvent(board, event, players);
    }
  }
  return boards;
};

const memoryName = (players: readonly Player[], id: string): string =>
  players.find((player) => player.id === id)?.name ?? id;

const percentage = (value: number): string => `${Math.round(value * 100)}%`;

const formatGoodBoard = (board: GoodEvidenceBoard, players: readonly Player[]): string => {
  const nodes = Object.values(board.nodes).map((node) => {
    const behavior = node.behavior;
    const latest = node.evidence.at(-1);
    return `- ${memoryName(players, node.playerId)}：发言${behavior.speechCount}次，沉默度${percentage(behavior.silenceRate)}，前后一致性${percentage(behavior.consistencyScore)}，自相矛盾${behavior.contradictionCount}次${latest ? `；最新证据[${levelLabel(latest.level)}]${latest.summary}` : ''}`;
  });
  const evidence = Object.values(board.nodes)
    .flatMap((node) => node.evidence.slice(-2).map((item) =>
      `[${levelLabel(item.level)}] ${memoryName(players, item.subjectId)}：${item.summary}${item.contradictsOtherSpeech ? '（与其他发言冲突）' : ''}`,
    ))
    .slice(-12);
  const contradictions = Object.values(board.nodes)
    .flatMap((node) => node.contradictions.slice(-2).map((item) => item.summary))
    .slice(-8);
  return [
    '【我的好人证据链板】（只引用服务端已注入的公开/本人私有事实）',
    '席位行为节点：',
    nodes.join('\n') || '无',
    '证据分级：',
    evidence.join('\n') || '暂无；新判断只能标记为存疑或不足',
    '前后矛盾：',
    contradictions.join('\n') || '暂无已识别的自证矛盾',
    '发言引用方式：优先使用“我之前记录了……，因为……；这条目前是存疑/不足/铁证”连接新旧判断，不要把推测说成服务端事实。',
  ].join('\n');
};

const formatWolfBoard = (board: WolfPlanBoard, players: readonly Player[]): string => {
  const targets = Object.values(board.targets)
    .filter((target) => players.find((player) => player.id === target.playerId)?.role !== 'wolf')
    .sort((left, right) => right.threatScore - left.threatScore)
    .map((target) =>
      `- ${memoryName(players, target.playerId)}：${target.priority}威胁${target.threatScore}（${target.reasons.join('、') || '暂无高价值信号'}）`,
    );
  const day = board.dayPlans.slice(-3).map((plan) => `- ${plan.text}`);
  const night = board.nightPlans.slice(-4).map((plan) => `- ${plan.text}`);
  return [
    '【我的狼人攻杀板】（狼队私有；目标是破局，不是找狼）',
    '高价值目标排序（优先暴露神职、信息位、强带队；不优先刀沉默低威胁位）：',
    targets.join('\n') || '暂无；先观察公开发言',
    `当前焦点：${board.focusTargetId ? memoryName(players, board.focusTargetId) : '未锁定'}`,
    '连续昼间计划：',
    day.join('\n') || '- 尚未形成昼间计划',
    '连续夜间计划：',
    night.join('\n') || '- 尚未形成夜间计划',
    '狼队讨论应沿用并修正以上计划，避免按座位号、固定一号或潜水低威胁机械选刀。',
  ].join('\n');
};

export const formatAIMemoryBoard = (
  board: AIMemoryBoard | undefined,
  players: readonly Player[],
): string => {
  if (!board) return '【我的思维链记忆板】\n暂无已持久化记忆；从当前公开事实建立第一条证据。';
  return board.kind === 'good_evidence'
    ? formatGoodBoard(board, players)
    : formatWolfBoard(board, players);
};

export const recommendedWolfTarget = (
  board: AIMemoryBoard | undefined,
  legalTargetIds: readonly string[],
): string | null => {
  if (!board || board.kind !== 'wolf_plan') return legalTargetIds[0] ?? null;
  const legal = new Set(legalTargetIds);
  const order = new Map(legalTargetIds.map((id, index) => [id, index]));
  const best = Object.values(board.targets)
    .filter((target) => legal.has(target.playerId))
    .sort((left, right) =>
      right.threatScore - left.threatScore ||
      (order.get(left.playerId) ?? 0) - (order.get(right.playerId) ?? 0),
    )
    .at(0);
  // A completely unobserved board should not turn the first seat into a
  // hidden fixed target. Let the caller use its normal randomized fallback
  // until there is an actual break-glass signal to act on.
  return best && best.threatScore > 0 ? best.playerId : null;
};

export const evidenceLevelLabel = levelLabel;

/** Used by migrations/tests to assert all seats have a node. */
export const memorySeatCount = (board: AIMemoryBoard): number =>
  board.kind === 'good_evidence'
    ? Object.keys(board.nodes).length
    : Object.keys(board.targets).length;

export const roleForMemoryBoard = (board: AIMemoryBoard, players: readonly Player[]): Role | null =>
  players.find((player) => player.id === board.ownerId)?.role ?? null;
