// Drives the real src/inject.js hook against synthetic GraphQL payloads, using
// Node's global fetch/Response. Exercises harvesting, retweet/reply pruning,
// the config handshake, and status reporting — the extension's core behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/rules.js'; // sets globalThis.__XRules, which inject.js depends on

const CHANNEL = 'x-interceptor';
const URL_ = 'https://x.com/i/api/graphql/QUERYID/UserTweets';
const BLOCKED = '\u{1F680}'; // 🚀 in the blocked account's display name

// ---- fake browser environment + one hook install (shared across tests) ----
const posted = [];
const listeners = {};
const payloadRef = { value: null };

const win = {
  addEventListener: (type, fn) => ((listeners[type] ||= []).push(fn)),
  postMessage: (msg) => posted.push(msg),
  // The "original" fetch inject.js wraps: returns the current test payload.
  fetch: async () =>
    new Response(JSON.stringify(payloadRef.value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
};

globalThis.window = win;
globalThis.location = { origin: 'https://x.com' };
globalThis.XMLHttpRequest = class {
  open() {}
  send() {}
};

// Neutralize the handshake setInterval so it can't keep the process alive.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
await import('../src/inject.js');
globalThis.setInterval = realSetInterval;

const dispatch = (data) => (listeners.message || []).forEach((fn) => fn({ source: win, data }));
const setConfig = (config) => dispatch({ __channel: CHANNEL, type: 'config', config });

async function runFetch(payload) {
  const before = posted.length;
  payloadRef.value = payload;
  const res = await win.fetch(URL_); // win.fetch is now inject.js's wrapper
  const json = await res.json();
  return { json, messages: posted.slice(before) };
}

// ---- payload builders ----
const user = (screen_name, name) => ({
  __typename: 'User',
  rest_id: 'u_' + screen_name,
  core: { screen_name, name },
  legacy: { screen_name, name },
});
const tweet = (id, u, text, extra = {}) => ({
  __typename: 'Tweet',
  rest_id: id,
  core: { user_results: { result: u } },
  legacy: { id_str: id, full_text: text, ...extra },
});

const FATE = user('fatima', 'Fatima ' + BLOCKED);
const OTHER = user('mahdieh', 'Mahdieh');

const entriesOf = (json) =>
  json.data.user.result.timeline_v2.timeline.instructions[0].entries;

function payload() {
  const plain = {
    entryId: 'tweet-1',
    content: { itemContent: { tweet_results: { result: tweet('1', OTHER, 'hi') } } },
  };
  const retweet = {
    entryId: 'tweet-2',
    content: {
      itemContent: {
        tweet_results: {
          result: tweet('2', FATE, 'RT @mahdieh: hi', {
            retweeted_status_result: { result: tweet('1', OTHER, 'hi') },
          }),
        },
      },
    },
  };
  const thread = {
    entryId: 'profile-conversation-3',
    content: {
      __typename: 'TimelineTimelineModule',
      items: [
        { entryId: 'c3-4', item: { itemContent: { tweet_results: { result: tweet('4', FATE, 'reply a') } } } },
        { entryId: 'c3-5', item: { itemContent: { tweet_results: { result: tweet('5', OTHER, 'reply b') } } } },
      ],
    },
  };
  const cursor = {
    entryId: 'cursor-bottom-9',
    content: { __typename: 'TimelineTimelineCursor', value: 'x' },
  };
  return {
    data: {
      user: {
        result: {
          timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [plain, retweet, thread, cursor] }] } },
        },
      },
    },
  };
}

// ---- tests ----
test('hook installed and requested its config', () => {
  assert.equal(win.__xInterceptorInstalled, true);
  assert.ok(posted.some((m) => m.type === 'config-request'));
});

test('capture only (no rules): harvests tweets, mutates nothing', async () => {
  setConfig({ capture: true, hideBlocked: false, matchMode: 'block', blockNames: [], blockUsers: [], blockKeywords: [] });
  const { json, messages } = await runFetch(payload());

  const tweetsMsg = messages.find((m) => m.type === 'tweets');
  assert.ok(tweetsMsg, 'a tweets message is posted');
  assert.equal(tweetsMsg.tweets.length, 5); // plain + retweeter + original + 2 replies
  assert.ok(!messages.some((m) => m.type === 'blocked'), 'nothing pruned');
  assert.deepEqual(
    entriesOf(json).map((e) => e.entryId),
    ['tweet-1', 'tweet-2', 'profile-conversation-3', 'cursor-bottom-9'],
    'payload passes through unchanged'
  );
});

test('block mode: removes a retweet by the blocked account, keeps the rest', async () => {
  setConfig({ capture: true, hideBlocked: true, matchMode: 'block', blockNames: [BLOCKED], blockUsers: [], blockKeywords: [] });
  const { json, messages } = await runFetch(payload());
  const ids = entriesOf(json).map((e) => e.entryId);

  assert.ok(!ids.includes('tweet-2'), 'retweet by blocked account removed');
  assert.ok(ids.includes('tweet-1'), 'unrelated tweet kept');
  assert.ok(ids.includes('cursor-bottom-9'), 'cursor preserved');
  assert.ok(messages.some((m) => m.type === 'blocked' && m.count >= 1), 'blocked count reported');
});

test('block mode: prunes only the matching reply inside a thread', async () => {
  setConfig({ capture: true, hideBlocked: true, matchMode: 'block', blockNames: [BLOCKED], blockUsers: [], blockKeywords: [] });
  const { json } = await runFetch(payload());
  const thread = entriesOf(json).find((e) => e.entryId === 'profile-conversation-3');

  assert.ok(thread, 'thread survives (it still has a non-blocked reply)');
  assert.deepEqual(thread.content.items.map((i) => i.entryId), ['c3-5'], 'only the blocked reply is pruned');
});

test('status message reflects a live, configured hook', async () => {
  setConfig({ capture: true, hideBlocked: true, matchMode: 'block', blockNames: [BLOCKED], blockUsers: [], blockKeywords: [] });
  const { messages } = await runFetch(payload());
  const status = messages.filter((m) => m.type === 'status').pop();

  assert.ok(status, 'a status message is posted');
  assert.equal(status.configReceived, true);
  assert.equal(status.filtering, true);
  assert.equal(status.rules, 1);
});
