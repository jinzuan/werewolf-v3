import type { Role } from './types';

/** The role counts selected by the catalog and persisted with a room. */
export type RoleSetup = Record<Role, number>;

export const ROOM_STATUSES = [
  'waiting',
  'ready_check',
  'starting',
  'playing',
  'ended',
] as const;

export type RoomStatus = (typeof ROOM_STATUSES)[number];

export const ROOM_MODES = ['human', 'mixed', 'quick_computer'] as const;

export type RoomMode = (typeof ROOM_MODES)[number];

export const ROOM_VISIBILITIES = ['invite_only', 'listed'] as const;

export type RoomVisibility = (typeof ROOM_VISIBILITIES)[number];

export const AI_FILL_POLICIES = ['none', 'fixed', 'fill_to_max'] as const;

export type AIFillPolicy = (typeof AI_FILL_POLICIES)[number];

export const READY_POLICIES = ['all_connected_humans'] as const;

export type ReadyPolicy = (typeof READY_POLICIES)[number];

/** Non-sensitive provider settings safe to persist with a room. */
export type RoomAIProvider = 'siliconflow' | 'deepseek' | 'local' | 'custom';
export type RoomAIBehavior = 'aggressive' | 'conservative' | 'random';

export interface RoomAIProviderConfig {
  provider: RoomAIProvider;
  model: string;
  endpoint: string;
  temperature: number;
  maxTokens: number;
  behavior: RoomAIBehavior;
}

/**
 * Create-time input only. `apiKey`/`token` are accepted over the protected
 * transport and are immediately moved to the server SecretStore; they must
 * never be copied into RoomRecord, RoomView, events, or logs.
 */
export interface RoomAIConfig extends RoomAIProviderConfig {
  apiKey?: string;
  token?: string;
}

export interface RoomRolePreset {
  id: string;
  name: string;
  playerCount: number;
  roleSetup: RoleSetup;
  rulesetId: string;
  rulesetVersion: string;
  enabled: boolean;
  unavailableReason?: string;
}

export interface RoomCreationCatalog {
  catalogVersion: string;
  playerCounts: number[];
  rolePresets: RoomRolePreset[];
  roleLimits: Partial<Record<Role, { min: number; max: number }> >;
  limits: {
    roomNameMax: number;
    displayNameMax: number;
    maxSpectators: number;
  };
}

/** The only client-to-server shape for creating a V3.1 room. */
export interface CreateRoomOptionsV31 {
  catalogVersion: string;
  roomName: string;
  creator: { name: string; avatarId: string };
  mode: RoomMode;
  visibility: RoomVisibility;
  maxPlayers: number;
  minHumanPlayers: number;
  computerSeats: number;
  aiFillPolicy: AIFillPolicy;
  roleSetup: RoleSetup;
  rolePresetId?: string;
  rulesetId: string;
  rulesetVersion: string;
  readyPolicy: ReadyPolicy;
  allowPublicSpectators: boolean;
  reviewEnabled: boolean;
  /** Create-time only; values are moved to SecretStore immediately. */
  aiConfig?: RoomAIConfig;
}

/**
 * The create request identity is deliberately outside the editable wizard
 * options.  A client may resend this envelope after an ACK was lost without
 * changing the room configuration or minting a second room.
 */
export interface CreateRoomCommandPayload {
  createRequestId: string;
  options: CreateRoomOptionsV31;
}

/** Normalized room configuration echoed by create, waiting, and game views. */
export interface RoomConfigView {
  catalogVersion: string;
  mode: RoomMode;
  visibility: RoomVisibility;
  maxPlayers: number;
  minHumanPlayers: number;
  computerSeats: number;
  aiFillPolicy: AIFillPolicy;
  roleSetup: RoleSetup;
  rolePresetId?: string;
  rulesetId: string;
  rulesetVersion: string;
  readyPolicy: ReadyPolicy;
  allowPublicSpectators: boolean;
  reviewEnabled: boolean;
}

export interface RoomConfigIssue {
  path: string;
  messageKey: string;
  params?: Record<string, string | number>;
  errorCode: string;
}

export type RoomMemberKind = 'player' | 'spectator';

export interface RoomMemberViewV31 {
  id: string;
  name: string;
  kind: RoomMemberKind;
  seatIndex: number | null;
  isAI: boolean;
  isHost: boolean;
  connected: boolean;
  ready: boolean | null;
  avatarId: string;
}

export interface RoomCounts {
  playerSeats: number;
  humanPlayers: number;
  onlineHumanPlayers: number;
  readyHumanPlayers: number;
  spectators: number;
}

export const START_CHECK_KEYS = [
  'config_valid',
  'role_count',
  'minimum_humans',
  'all_humans_online',
  'all_humans_ready',
  'ai_fill',
  'ruleset_available',
] as const;

export type StartCheckKey = (typeof START_CHECK_KEYS)[number];

export interface StartCheckItem {
  key: StartCheckKey;
  passed: boolean;
  messageKey: string;
  params?: Record<string, string | number>;
  affectedMemberIds?: string[];
}

export interface StartCheck {
  passed: boolean;
  items: StartCheckItem[];
}

export const ALLOWED_ROOM_ACTIONS = [
  'update_config',
  'begin_ready_check',
  'cancel_ready_check',
  'set_ready',
  'start_game',
  'leave',
  'invite',
  'transfer_host',
  'dissolve',
] as const;

export type AllowedRoomAction = (typeof ALLOWED_ROOM_ACTIONS)[number];

export interface RoomViewerViewV31 {
  actorId: string;
  kind: RoomMemberKind;
  omniscient: boolean;
  allowedRoomActions: AllowedRoomAction[];
}

/** The room fact visible to one bound socket. It contains no credentials or game session. */
export interface RoomViewV31 {
  id: string;
  code: string;
  name: string;
  roomRevision: number;
  status: RoomStatus;
  config: RoomConfigView;
  configRevision: number;
  configLocked: boolean;
  members: RoomMemberViewV31[];
  counts: RoomCounts;
  startCheck: StartCheck;
  viewer: RoomViewerViewV31;
  gameId?: string;
  createdAt: number;
}

/** A summary is intentionally smaller than RoomView and is only for the lobby. */
export interface RoomSummaryV31 {
  roomCode: string;
  roomName: string;
  status: RoomStatus;
  mode: RoomMode;
  minHumanPlayers: number;
  playerCount: number;
  maxPlayers: number;
  onlinePlayers: number;
  onlineCount: number;
  readyCount: number;
  spectatorCount: number;
}

export const ROOM_SNAPSHOT_REASONS = [
  'created',
  'joined',
  'left',
  'disconnected',
  'reconnected',
  'ready_changed',
  'config_changed',
  'host_changed',
  'status_changed',
] as const;

export type RoomSnapshotReason = (typeof ROOM_SNAPSHOT_REASONS)[number];

export type EmptyRoomCommandPayload = Record<string, never>;

export type RoomReadCommand =
  | { type: 'catalog.get'; payload: EmptyRoomCommandPayload }
  | { type: 'room.create'; payload: CreateRoomCommandPayload }
  | { type: 'room.join'; payload: { roomCode: string; joinToken?: string } }
  | { type: 'room.resume'; payload: { roomCode: string } }
  | { type: 'room.get'; payload: { roomCode: string } };

export type RoomMutationCommand =
  | {
      type: 'room.update_config';
      payload: { config: RoomConfigView };
    }
  | { type: 'room.begin_ready_check'; payload: EmptyRoomCommandPayload }
  | { type: 'room.cancel_ready_check'; payload: EmptyRoomCommandPayload }
  | { type: 'room.ready'; payload: { ready: boolean } }
  | { type: 'room.start_game'; payload: EmptyRoomCommandPayload }
  | { type: 'room.leave'; payload: EmptyRoomCommandPayload }
  | {
      type: 'room.transfer_host';
      payload: { targetMemberId: string };
    }
  | { type: 'room.dissolve'; payload: { confirm: boolean } };

export type RoomCommand = RoomReadCommand | RoomMutationCommand;

export interface RoomSnapshotMessage {
  type: 'room.snapshot';
  room: RoomViewV31;
  reason: RoomSnapshotReason;
}
