import assert from 'node:assert/strict';
import test from 'node:test';
import { renderServerLandingPage } from '../app/serverLandingPage';

test('server landing page is human-readable and links back to the game', () => {
  const page = renderServerLandingPage('http', '39.96.207.42');
  assert.match(page, /服务端运行正常/);
  assert.match(page, /http:\/\/39\.96\.207\.42:5317\//);
  assert.match(page, /href="\/health"/);
});
