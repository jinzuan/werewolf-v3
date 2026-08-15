import assert from 'node:assert/strict';
import test from 'node:test';
import { RULESET } from '../../src/core/rules';
import { RoomProjector } from '../rooms/roomProjector';
import type { RoomRecord } from '../rooms/types';

test('public RoomView keeps AI tuning private and never projects a credential reference', () => {
  const room: RoomRecord = {
    id: 'room-ai-projection',
    code: 'AIPROJ',
    name: 'projection',
    joinToken: 'join-secret',
    omniscientToken: 'omniscient-secret',
    hostId: 'host',
    maxPlayers: 12,
    status: 'waiting',
    auto: false,
    debugMode: false,
    configLocked: false,
    roomRevision: 3,
    configRevision: 2,
    config: {
      mode: 'mixed',
      visibility: 'invite_only',
      maxPlayers: 12,
      minHumanPlayers: 1,
      computerSeats: 11,
      aiFillPolicy: 'fixed',
      roleSetup: { ...RULESET.values['game.role_setup'] },
      rulesetId: RULESET.id,
      rulesetVersion: RULESET.rulesetVersion,
      catalogVersion: 'test',
      readyPolicy: 'all_connected_humans',
      allowPublicSpectators: false,
      aiProviderConfig: {
        provider: 'custom',
        model: 'private-model',
        endpoint: 'http://127.0.0.1:1234/v1',
        temperature: .7,
        maxTokens: 256,
        behavior: 'random',
      },
      credentialRef: 'cr_private_ref',
    },
    members: [{
      id: 'host',
      name: 'Host',
      kind: 'player',
      connected: true,
      omniscient: false,
      resumeToken: 'resume',
      seatIndex: 0,
      isAI: false,
      ready: false,
      avatarId: 'avatar-player',
    }],
    players: [],
    createdAt: 1,
  };

  const projected = new RoomProjector().project(room, 'host');
  assert.equal('aiProviderConfig' in projected.config, false);
  assert.equal('credentialRef' in projected, false);
  assert.doesNotMatch(JSON.stringify(projected), /private-model|cr_private_ref/);
});
