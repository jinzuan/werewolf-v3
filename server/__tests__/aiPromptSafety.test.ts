import assert from 'node:assert/strict';
import test from 'node:test';
import { loadExperienceLibrary } from '../ai/experienceLibrary';
import { buildPromptPipeline } from '../ai/promptPipeline';
import { createPlayers } from './fixtures';

const forbiddenExternalRoleNames = /夜神|白天使/u;

test('experience assets do not inject the reported external role names', () => {
  const library = loadExperienceLibrary();
  for (const asset of library.assets) {
    assert.doesNotMatch(asset.content, forbiddenExternalRoleNames, asset.path);
  }
});

test('every AI prompt declares the complete six-role catalog', () => {
  const players = createPlayers();
  const roles = ['wolf', 'seer', 'witch', 'hunter', 'guardian', 'villager'] as const;
  const roleLabels = ['狼人', '预言家', '女巫', '猎人', '守卫', '平民'];

  for (const [index, role] of roles.entries()) {
    const prompt = buildPromptPipeline({
      roomId: 'room-1',
      gameId: 'game-1',
      playerId: players[index].id,
      role,
      phase: 'day',
      stage: 'speech',
      stageRevision: 1,
      callId: `role-catalog-${role}`,
      players,
      allowedActions: ['speak'],
      allowedCommandTypes: ['game.speak'],
    }).prompt;
    const rendered = `${prompt.system}\n${prompt.user}`;

    assert.match(rendered, /本局只存在以下角色/u, role);
    for (const label of roleLabels) assert.match(rendered, new RegExp(label, 'u'), role);
    assert.doesNotMatch(rendered, forbiddenExternalRoleNames, role);
  }
});
