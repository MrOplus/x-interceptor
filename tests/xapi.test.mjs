// Tests the X block/mute request builder. It's pure, so we can assert the exact
// URL, method, headers and body without ever touching the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/xapi.js';

const A = globalThis.__XApi;
const auth = { bearer: 'Bearer AAAA', csrf: 'ct0value' };

test('block: correct endpoint, method, body and auth headers', () => {
  const req = A.buildActionRequest('block', '12345', auth);
  assert.equal(req.url, 'https://x.com/i/api/1.1/blocks/create.json');
  assert.equal(req.method, 'POST');
  assert.equal(req.body, 'user_id=12345');
  assert.equal(req.headers.authorization, 'Bearer AAAA');
  assert.equal(req.headers['x-csrf-token'], 'ct0value');
  assert.equal(req.headers['x-twitter-auth-type'], 'OAuth2Session');
  assert.equal(req.headers['x-twitter-active-user'], 'yes');
  assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
});

test('mute uses the mutes endpoint', () => {
  assert.equal(
    A.buildActionRequest('mute', '9', auth).url,
    'https://x.com/i/api/1.1/mutes/users/create.json'
  );
});

test('unblock/unmute map to the destroy endpoints', () => {
  assert.equal(A.buildActionRequest('unblock', '9', auth).url, A.ENDPOINTS.unblock);
  assert.equal(A.buildActionRequest('unmute', '9', auth).url, A.ENDPOINTS.unmute);
});

test('user id is url-encoded into the body', () => {
  assert.equal(A.buildActionRequest('block', '1 2&3', auth).body, 'user_id=1%202%263');
});

test('throws on unknown action, missing id, or missing auth', () => {
  assert.throws(() => A.buildActionRequest('nuke', '1', auth));
  assert.throws(() => A.buildActionRequest('block', '', auth));
  assert.throws(() => A.buildActionRequest('block', '1', null));
  assert.throws(() => A.buildActionRequest('block', '1', { bearer: 'x' })); // no csrf
});
