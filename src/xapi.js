/**
 * Pure builder for X's block/mute/unblock endpoints. No chrome.* or DOM, so it
 * can be unit-tested; bridge.js performs the actual request in the x.com page
 * context (where the session cookies live).
 */
(() => {
  'use strict';

  const ENDPOINTS = {
    block: 'https://x.com/i/api/1.1/blocks/create.json',
    unblock: 'https://x.com/i/api/1.1/blocks/destroy.json',
    mute: 'https://x.com/i/api/1.1/mutes/users/create.json',
    unmute: 'https://x.com/i/api/1.1/mutes/users/destroy.json',
  };

  /**
   * @param {'block'|'unblock'|'mute'|'unmute'} kind
   * @param {string} userId  numeric X user id (rest_id) of the target account
   * @param {{bearer:string, csrf:string}} auth  captured from a real request
   * @returns {{url,method,headers,body}}
   */
  function buildActionRequest(kind, userId, auth) {
    const url = ENDPOINTS[kind];
    if (!url) throw new Error('Unknown action: ' + kind);
    if (!userId) throw new Error('Missing target user id.');
    if (!auth || !auth.bearer || !auth.csrf) {
      throw new Error('No X session captured yet — open or scroll x.com, then retry.');
    }
    return {
      url,
      method: 'POST',
      headers: {
        authorization: auth.bearer,
        'x-csrf-token': auth.csrf,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'user_id=' + encodeURIComponent(userId),
    };
  }

  globalThis.__XApi = { ENDPOINTS, buildActionRequest };
})();
