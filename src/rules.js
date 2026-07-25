/**
 * Shared matching logic. Loaded into the MAIN world alongside inject.js and by
 * the extension pages, so the preview in the dashboard scores rules with the
 * exact code that prunes the timeline — the two can't drift.
 */
(() => {
  'use strict';

  const DEFAULT_CONFIG = {
    capture: true,
    hideBlocked: false,
    matchMode: 'block',
    blockUsers: [],
    blockNames: [],
    blockKeywords: [],
  };

  const VARIATION_SELECTORS = /[\uFE0E\uFE0F]/g;

  /**
   * Emoji compare byte-for-byte, but only after normalizing presentation:
   * `❤️` (with U+FE0F) and `❤` are the same glyph to a human and different
   * strings to `includes()`. NFC also settles decomposed accents in names.
   */
  const norm = (value) =>
    String(value ?? '')
      .normalize('NFC')
      .replace(VARIATION_SELECTORS, '')
      .toLowerCase();

  /** One term per line. Blank lines and `#` comments are ignored, so rule
   *  lists can be grouped and annotated. */
  const parseTerms = (text) =>
    String(text ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

  const formatTerms = (terms) => (terms || []).join('\n');

  const hasRules = (config) =>
    Boolean(
      config?.blockUsers?.length ||
        config?.blockNames?.length ||
        config?.blockKeywords?.length
    );

  /** Which rule scopes a tweet trips — drives both filtering and preview. */
  function matchScopes(tweet, config) {
    const scopes = [];

    const users = config?.blockUsers || [];
    if (users.some((u) => norm(u.replace(/^@/, '')) === norm(tweet.username))) {
      scopes.push('user');
    }

    // Substring, not equality — display names are decorated, e.g. "Ali 🚀".
    const names = config?.blockNames || [];
    if (names.length) {
      const name = norm(tweet.name);
      if (names.some((n) => n && name.includes(norm(n)))) scopes.push('name');
    }

    const keywords = config?.blockKeywords || [];
    if (keywords.length) {
      const text = norm(tweet.text);
      if (keywords.some((k) => k && text.includes(norm(k)))) scopes.push('text');
    }

    return scopes;
  }

  const matchesRules = (tweet, config) => matchScopes(tweet, config).length > 0;

  /**
   * Decided per timeline entry, not per tweet: a conversation entry carries
   * several tweets. In `keep` mode the rules act as an allowlist, so an entry
   * survives if *any* of its tweets match; in `block` mode it dies if any do.
   */
  function entryShouldGo(tweets, config) {
    if (!tweets.length || !hasRules(config)) return false;
    return config.matchMode === 'keep'
      ? !tweets.some((t) => matchesRules(t, config))
      : tweets.some((t) => matchesRules(t, config));
  }

  /** Per-term hit counts against a captured sample — answers "does 🚀
   *  actually match anything?" before the rule goes live. */
  function termHits(tweets, config) {
    const scopes = [
      ['name', config?.blockNames || [], (t) => norm(t.name)],
      ['user', config?.blockUsers || [], (t) => norm(t.username)],
      ['text', config?.blockKeywords || [], (t) => norm(t.text)],
    ];

    const out = [];
    for (const [scope, terms, field] of scopes) {
      for (const term of terms) {
        const needle = norm(scope === 'user' ? term.replace(/^@/, '') : term);
        const hits = tweets.filter((t) =>
          scope === 'user' ? field(t) === needle : field(t).includes(needle)
        ).length;
        out.push({ scope, term, hits });
      }
    }
    return out;
  }

  /**
   * Turns a search box query into a tweet predicate. Shared by the popup and
   * dashboard so their search behaves identically:
   *   `name:🚀` / `text:airdrop` / `@handle` scope to one field;
   *   a bare term matches handle, name or text.
   * Returns null for an empty query (meaning "match everything").
   */
  function buildPredicate(raw) {
    const query = String(raw ?? '').trim();
    if (!query) return null;

    const scoped = /^(name|text|user|handle)\s*:\s*(.+)$/is.exec(query);
    if (scoped) {
      const needle = norm(scoped[2]);
      const field = scoped[1].toLowerCase();
      if (field === 'name') return (t) => norm(t.name).includes(needle);
      if (field === 'text') return (t) => norm(t.text).includes(needle);
      return (t) => norm(t.username).includes(needle);
    }

    if (query.startsWith('@')) {
      const needle = norm(query.slice(1));
      return (t) => norm(t.username).includes(needle);
    }

    const needle = norm(query);
    return (t) =>
      norm(t.username).includes(needle) ||
      norm(t.name).includes(needle) ||
      norm(t.text).includes(needle);
  }

  /**
   * Validates and normalizes an imported rules file. Accepts the exported
   * envelope ({ rules: {...} }) or a bare rules object, coerces every field,
   * and throws on anything unrecognizable.
   */
  function sanitizeRules(parsed) {
    if (!parsed || typeof parsed !== 'object') throw new Error('Not a rules file.');
    const src = parsed.rules && typeof parsed.rules === 'object' ? parsed.rules : parsed;

    const list = (value) =>
      Array.isArray(value)
        ? value.filter((t) => typeof t === 'string').map((t) => t.trim()).filter(Boolean)
        : [];

    const hasAnyList = ['blockNames', 'blockUsers', 'blockKeywords'].some((k) =>
      Array.isArray(src[k])
    );
    if (!hasAnyList) throw new Error('No rule lists found in that file.');

    return {
      matchMode: src.matchMode === 'keep' ? 'keep' : 'block',
      blockNames: list(src.blockNames),
      blockUsers: list(src.blockUsers),
      blockKeywords: list(src.blockKeywords),
    };
  }

  globalThis.__XRules = {
    DEFAULT_CONFIG,
    norm,
    parseTerms,
    formatTerms,
    hasRules,
    matchScopes,
    matchesRules,
    entryShouldGo,
    termHits,
    buildPredicate,
    sanitizeRules,
  };
})();
