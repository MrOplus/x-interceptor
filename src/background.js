/**
 * Service worker: dedupes and persists what the content scripts harvest.
 * Writes are buffered because a busy timeline fires many GraphQL calls per
 * second and chrome.storage has a write-rate quota.
 */

const MAX_TWEETS = 5000;
const FLUSH_MS = 1500;
const FLUSH_AT = 100;

const DEFAULT_CONFIG = {
  capture: true,
  hideBlocked: false,
  matchMode: 'block',
  blockUsers: [],
  blockNames: [],
  blockKeywords: [],
};

let buffer = [];
let flushTimer = null;

/**
 * Written straight through, not throttled. A bare setTimeout does not keep an
 * MV3 service worker alive, so a deferred write loses the report whenever the
 * worker is torn down before it fires — which is exactly what happens after a
 * burst of activity followed by an idle tab. storage.local has no write-rate
 * quota, and these are a handful of small writes per second at worst.
 */
function writeStatus(status) {
  if (!status) return;
  chrome.storage.local.set({ lastStatus: { ...status, at: Date.now() } });
}

/** Records that the user blocked/muted an account, so the matched-accounts page
 *  can show the acted-on state across reloads. Serialized read-modify-write. */
let xActionWrite = Promise.resolve();
function recordAction(userId, kind) {
  xActionWrite = xActionWrite.then(async () => {
    const { xActions = {} } = await chrome.storage.local.get('xActions');
    xActions[userId] = kind;
    await chrome.storage.local.set({ xActions });
  });
  return xActionWrite;
}

/** Serialized read-modify-write; the counter lives in storage because the
 *  service worker is evicted between bursts of activity. */
let blockedWrite = Promise.resolve();
function bumpBlocked(count) {
  blockedWrite = blockedWrite.then(async () => {
    const { blockedCount = 0 } = await chrome.storage.local.get('blockedCount');
    await chrome.storage.local.set({ blockedCount: blockedCount + count });
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { config } = await chrome.storage.local.get('config');
  if (!config) await chrome.storage.local.set({ config: DEFAULT_CONFIG });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message?.type) {
    case 'tweets':
      buffer.push(...message.tweets.filter((t) => t.id));
      scheduleFlush();
      return false;

    case 'blocked':
      bumpBlocked(message.count);
      return false;

    case 'status':
      writeStatus(message.status);
      return false;

    case 'getState':
      (async () => {
        await flush();
        await blockedWrite;
        const {
          tweets = [],
          config = DEFAULT_CONFIG,
          blockedCount = 0,
          lastStatus = null,
          xActions = {},
        } = await chrome.storage.local.get([
          'tweets',
          'config',
          'blockedCount',
          'lastStatus',
          'xActions',
        ]);
        sendResponse({ tweets, config, blockedCount, lastStatus, xActions });
      })();
      return true;

    case 'setConfig':
      (async () => {
        const { config = DEFAULT_CONFIG } = await chrome.storage.local.get('config');
        const next = { ...config, ...message.config };
        await chrome.storage.local.set({ config: next });
        sendResponse({ config: next });
      })();
      return true;

    case 'clear':
      (async () => {
        buffer = [];
        await blockedWrite;
        await chrome.storage.local.set({ tweets: [], blockedCount: 0 });
        sendResponse({ ok: true });
      })();
      return true;

    case 'xaction':
      // Relay a user-initiated block/mute to a content script on an open x.com
      // tab, which has the session context to perform it. Everything is wrapped
      // so any failure returns a real message instead of a dropped response.
      (async () => {
        try {
          const tabs = await chrome.tabs.query({
            url: ['https://x.com/*', 'https://twitter.com/*'],
          });
          if (!tabs.length) {
            sendResponse({ ok: false, error: 'Open an x.com tab first, then retry.' });
            return;
          }

          let resp;
          try {
            resp = await chrome.tabs.sendMessage(tabs[0].id, {
              type: 'xaction',
              kind: message.kind,
              userId: message.userId,
            });
          } catch {
            sendResponse({
              ok: false,
              error: 'Reload your x.com tab — it is running an older version of the extension — then retry.',
            });
            return;
          }

          if (resp?.ok) await recordAction(message.userId, message.kind);
          sendResponse(
            resp || { ok: false, error: 'No response from the x.com tab — reload it and retry.' }
          );
        } catch (err) {
          sendResponse({ ok: false, error: 'Background error: ' + (err?.message || String(err)) });
        }
      })();
      return true;

    default:
      return false;
  }
});

function scheduleFlush() {
  if (buffer.length >= FLUSH_AT) {
    flush();
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_MS);
}

async function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!buffer.length) return;

  const incoming = buffer;
  buffer = [];

  const { tweets = [] } = await chrome.storage.local.get('tweets');

  // Newest first; later occurrences of an id lose, so freshly seen engagement
  // counts win over the copy already on disk.
  const byId = new Map();
  for (const tweet of [...incoming.reverse(), ...tweets]) {
    if (!byId.has(tweet.id)) byId.set(tweet.id, tweet);
  }

  await chrome.storage.local.set({
    tweets: [...byId.values()].slice(0, MAX_TWEETS),
  });
}
