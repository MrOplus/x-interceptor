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
        } = await chrome.storage.local.get([
          'tweets',
          'config',
          'blockedCount',
          'lastStatus',
        ]);
        sendResponse({ tweets, config, blockedCount, lastStatus });
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
