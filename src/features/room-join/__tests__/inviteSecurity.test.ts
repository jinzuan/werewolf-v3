import assert from 'node:assert/strict';
import test from 'node:test';
import { joinInviteUrl } from '../../../app/routes/roomRouting';

test('邀请链接只包含同源房间码和进入意图，不承载凭据', () => {
  const invite = joinInviteUrl(
    'https://forest.example/app?joinToken=should-not-copy#resumeToken=secret',
    ' ab12c ',
    'play',
  );
  const parsed = new URL(invite);
  assert.equal(parsed.origin, 'https://forest.example');
  assert.equal(parsed.pathname, '/rooms/join');
  assert.equal(parsed.search, '?code=AB12C&intent=play');
  assert.equal(parsed.hash, '');
  assert.doesNotMatch(invite, /joinToken|resumeToken|should-not-copy|secret/);
});
