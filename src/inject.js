/**
 * MAIN world. Runs at document_start, before X's bundle captures `fetch`.
 * No chrome.* APIs are available here — everything leaves via postMessage
 * and is picked up by bridge.js in the ISOLATED world.
 */
(() => {
  'use strict';

  if (window.__xInterceptorInstalled) return;
  window.__xInterceptorInstalled = true;

  const CHANNEL = 'x-interceptor';
  const GQL_RE = /\/i\/api\/graphql\//;

  let config = {
    capture: true,
    hideBlocked: false,
    matchMode: 'block',
    blockUsers: [],
    blockNames: [],
    blockKeywords: [],
  };

  let configReceived = false;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__channel !== CHANNEL || data.type !== 'config') return;
    config = { ...config, ...data.config };
    configReceived = true;
  });

  const post = (type, payload) => {
    window.postMessage({ __channel: CHANNEL, type, ...payload }, location.origin);
  };

  /**
   * Ask for the config instead of only waiting to be handed it. This world and
   * the bridge's are injected independently at document_start with no ordering
   * guarantee, so whichever runs second misses the other's opening message —
   * and a lost config leaves `hideBlocked` false, silently disabling all
   * filtering while capture (which defaults on) keeps working. Retry until the
   * bridge answers.
   */
  post('config-request', {});
  let handshakeTries = 0;
  const handshake = setInterval(() => {
    if (configReceived || (handshakeTries += 1) > 40) {
      clearInterval(handshake);
      return;
    }
    post('config-request', {});
  }, 50);

  /** `/i/api/graphql/<queryId>/<OperationName>` — the queryId rotates, the name doesn't. */
  const operationName = (url) => {
    try {
      const parts = new URL(url, location.origin).pathname.split('/');
      const i = parts.indexOf('graphql');
      return i >= 0 ? parts[i + 2] || null : null;
    } catch {
      return null;
    }
  };

  // ---------------------------------------------------------------- extraction

  /**
   * Walks the payload looking for Tweet nodes rather than indexing fixed paths
   * (`timeline_v2.timeline.instructions[...]`), which differ per endpoint and
   * change between deploys. Also transparently handles the
   * `TweetWithVisibilityResults` wrapper, which nests the real tweet one level
   * deeper.
   */
  function harvest(node, out = [], seen = new Set()) {
    if (!node || typeof node !== 'object') return out;
    if (seen.has(node)) return out;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) harvest(item, out, seen);
      return out;
    }

    if (node.__typename === 'Tweet' && node.legacy) {
      const tweet = toTweet(node);
      if (tweet) out.push(tweet);
    }

    for (const value of Object.values(node)) harvest(value, out, seen);
    return out;
  }

  function toTweet(node) {
    const legacy = node.legacy || {};
    const user = node.core?.user_results?.result;
    if (!user) return null;

    const userLegacy = user.legacy || {};
    // Newer payloads moved name/screen_name onto `core`; older ones keep them in `legacy`.
    const username = user.core?.screen_name ?? userLegacy.screen_name;
    if (!username) return null;

    return {
      id: node.rest_id || legacy.id_str,
      username,
      name: user.core?.name ?? userLegacy.name ?? '',
      userId: user.rest_id,
      verified: Boolean(user.is_blue_verified || userLegacy.verified),
      // note_tweet holds the untruncated body of long-form posts.
      text: node.note_tweet?.note_tweet_results?.result?.text ?? legacy.full_text ?? '',
      lang: legacy.lang,
      createdAt: legacy.created_at,
      replyCount: legacy.reply_count ?? 0,
      retweetCount: legacy.retweet_count ?? 0,
      likeCount: legacy.favorite_count ?? 0,
      quoteCount: legacy.quote_count ?? 0,
      isRetweet: Boolean(legacy.retweeted_status_result),
      isReply: Boolean(legacy.in_reply_to_status_id_str),
      url: `https://x.com/${username}/status/${node.rest_id || legacy.id_str}`,
    };
  }

  // ------------------------------------------------------------------ blocking

  // Matching lives in rules.js, loaded into this world just before us, so the
  // dashboard preview and this hook can never disagree about what a rule does.
  const { hasRules, entryShouldGo } = globalThis.__XRules;

  // Replies and retweets don't live in `entries` alone: conversation threads
  // are modules whose tweets hang off `items`, so pruning only `entries` leaves
  // them untouched.
  const PRUNABLE_ARRAYS = new Set(['entries', 'items', 'moduleItems']);

  /**
   * Drops timeline entries the rules reject, so the page never receives them
   * and React never renders them.
   *
   * An entry is identified by *containing a tweet*, never by an entryId prefix:
   * X names them differently per surface (`tweet-`, `profile-conversation-`,
   * `home-conversation-`, `conversationthread-`, …) and adds new ones without
   * notice, so a whitelist silently stops matching. Anything with no tweet
   * inside — cursors, "who to follow" modules — harvests empty and is always
   * kept, which keeps pagination safe for free.
   */
  function pruneBlocked(node, stats, seen = new Set()) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) pruneBlocked(item, stats, seen);
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (PRUNABLE_ARRAYS.has(key) && Array.isArray(value)) {
        node[key] = value.filter((entry) => {
          const before = harvest(entry).length;

          // Depth-first: prune a module's own item list before judging the
          // module, so one blocked reply costs the reply and not the thread.
          pruneBlocked(entry, stats, seen);

          const tweets = harvest(entry);
          if (!tweets.length) {
            // Nothing to begin with (a cursor) — keep. Emptied by the pass
            // above — drop, or the page renders a blank card. Its items were
            // already counted, so don't count it twice.
            return before === 0;
          }

          const remove = entryShouldGo(tweets, config);
          if (remove) stats.removed += 1;
          return !remove;
        });
      } else {
        pruneBlocked(value, stats, seen);
      }
    }
  }

  /**
   * @returns {{ body: string|null, tweets: object[] }} body is non-null only
   *   when the payload was actually modified and needs re-serializing.
   */
  function process(json, url) {
    const op = operationName(url);
    const tweets = harvest(json);

    if (config.capture && tweets.length) {
      post('tweets', { url, op, tweets });
    }

    const filtering = Boolean(config.hideBlocked) && hasRules(config);
    let removed = 0;
    let body = null;

    if (filtering) {
      const stats = { removed: 0 };
      pruneBlocked(json, stats);
      removed = stats.removed;
      if (removed) {
        body = JSON.stringify(json);
        post('blocked', { count: removed });
      }
    }

    // Reported every payload so the dashboard can show what the hook actually
    // believes — without it, a config that never arrived is indistinguishable
    // from rules that simply match nothing.
    post('status', {
      op,
      tweets: tweets.length,
      removed,
      filtering,
      configReceived,
      rules:
        (config.blockNames?.length || 0) +
        (config.blockUsers?.length || 0) +
        (config.blockKeywords?.length || 0),
    });

    return { body, tweets };
  }

  // --------------------------------------------------------------- fetch patch

  const originalFetch = window.fetch;

  window.fetch = async function fetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const response = await originalFetch.apply(this, arguments);

    if (!GQL_RE.test(url) || !response.ok) return response;

    try {
      // clone() is mandatory — reading the original stream would leave the page
      // with a consumed body and silently break the timeline.
      const json = await response.clone().json();
      const { body } = process(json, url);
      if (body === null) return response;

      const headers = new Headers(response.headers);
      headers.delete('content-length'); // now stale
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (err) {
      console.debug('[x-interceptor] fetch hook failed', err);
      return response;
    }
  };

  // ----------------------------------------------------------------- XHR patch

  const originalOpen = XMLHttpRequest.prototype.open;
  const responseTextDesc = Object.getOwnPropertyDescriptor(
    XMLHttpRequest.prototype,
    'responseText'
  );
  const responseDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');

  XMLHttpRequest.prototype.open = function open(method, url) {
    if (typeof url === 'string' && GQL_RE.test(url)) {
      installXhrTrap(this, url);
    }
    return originalOpen.apply(this, arguments);
  };

  /**
   * Rather than racing the page's `load` listener, we shadow `responseText` /
   * `response` on the instance. Whenever the page reads them — from any handler,
   * in any order — it gets the processed payload.
   */
  function installXhrTrap(xhr, url) {
    let cached; // undefined = not computed yet

    const compute = () => {
      if (cached !== undefined) return cached;
      if (xhr.readyState !== 4) return null;

      let raw = null;
      try {
        if (xhr.responseType === '' || xhr.responseType === 'text') {
          raw = responseTextDesc.get.call(xhr);
        } else if (xhr.responseType === 'json') {
          raw = JSON.stringify(responseDesc.get.call(xhr));
        }
      } catch {
        raw = null;
      }

      if (!raw) {
        cached = null;
        return cached;
      }

      try {
        const json = JSON.parse(raw);
        const { body } = process(json, url);
        cached = body; // null when unmodified — fall through to the real value
      } catch (err) {
        console.debug('[x-interceptor] xhr hook failed', err);
        cached = null;
      }
      return cached;
    };

    Object.defineProperty(xhr, 'responseText', {
      configurable: true,
      get() {
        return compute() ?? responseTextDesc.get.call(xhr);
      },
    });

    Object.defineProperty(xhr, 'response', {
      configurable: true,
      get() {
        const patched = compute();
        if (patched === null) return responseDesc.get.call(xhr);
        return xhr.responseType === 'json' ? JSON.parse(patched) : patched;
      },
    });
  }

  console.debug('[x-interceptor] hooks installed');
})();
