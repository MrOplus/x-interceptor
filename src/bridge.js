/**
 * ISOLATED world. The MAIN-world hook has no chrome.* access, so this relays
 * both ways: harvested tweets up to the service worker, config back down.
 */
(() => {
  'use strict';

  const CHANNEL = 'x-interceptor';

  // Auth for block/mute. The CSRF token (ct0) is read fresh from the cookie at
  // action time — always present when signed in — so nothing needs to be
  // captured first. The bearer is captured from the page's own API calls and
  // persisted; if none has been seen yet, we fall back to X's public web
  // bearer, so a first action works without having to scroll the timeline.
  const PUBLIC_BEARER =
    'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  let capturedBearer = null;

  chrome.storage.local.get('bearer').then(({ bearer }) => {
    if (bearer) capturedBearer = bearer;
  });

  const readCt0 = () => {
    const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  };

  const pushConfig = (config) => {
    window.postMessage({ __channel: CHANNEL, type: 'config', config }, location.origin);
  };

  const send = (message) => {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // Extension reloaded out from under the page — the tab needs a refresh.
    }
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__channel !== CHANNEL) return;

    if (data.type === 'tweets') {
      send({ type: 'tweets', url: data.url, op: data.op, tweets: data.tweets });
    } else if (data.type === 'blocked') {
      send({ type: 'blocked', count: data.count });
    } else if (data.type === 'status') {
      // Stamped here because the MAIN world has no chrome.* access. Content
      // scripts survive an extension reload until the tab is refreshed, so a
      // version older than the manifest's means the page is running stale code.
      send({
        type: 'status',
        status: { ...data, version: chrome.runtime.getManifest().version },
      });
    } else if (data.type === 'config-request') {
      // The hook retries this until answered, so an unlucky injection order
      // can't leave it stuck on defaults.
      chrome.storage.local.get('config').then(({ config }) => pushConfig(config || {}));
    } else if (data.type === 'auth') {
      // Persist the real bearer so it survives tab reloads and future sessions.
      if (data.bearer && data.bearer !== capturedBearer) {
        capturedBearer = data.bearer;
        chrome.storage.local.set({ bearer: data.bearer });
      }
    }
  });

  // Block/mute requests arrive from the matched-accounts page via the service
  // worker. We run the request here, in the x.com page context, so the session
  // cookies are sent same-origin. Reversible actions on the user's own account.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'xaction') return false;
    (async () => {
      try {
        if (!globalThis.__XApi) {
          throw new Error('Reload this x.com tab — it is running an older version of the extension.');
        }
        const csrf = readCt0();
        if (!csrf) throw new Error('Not signed in to X on this tab (no ct0 cookie).');
        const bearer = capturedBearer || PUBLIC_BEARER;

        const req = globalThis.__XApi.buildActionRequest(message.kind, message.userId, {
          bearer,
          csrf,
        });
        const res = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          credentials: 'include',
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`X returned HTTP ${res.status}${detail ? ': ' + detail.slice(0, 160) : ''}`);
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true; // async sendResponse
  });

  chrome.storage.local.get('config').then(({ config }) => {
    if (config) pushConfig(config);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.config) pushConfig(changes.config.newValue);
  });
})();
