/**
 * ISOLATED world. The MAIN-world hook has no chrome.* access, so this relays
 * both ways: harvested tweets up to the service worker, config back down.
 */
(() => {
  'use strict';

  const CHANNEL = 'x-interceptor';

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
    }
  });

  chrome.storage.local.get('config').then(({ config }) => {
    if (config) pushConfig(config);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.config) pushConfig(changes.config.newValue);
  });
})();
