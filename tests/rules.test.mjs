// Pure rule-logic tests. rules.js is a browser IIFE that assigns
// globalThis.__XRules as a side effect, so importing it here exposes the API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/rules.js';

const R = globalThis.__XRules;

const ROCKET = '\u{1F680}'; //  🚀
const IR = '\u{1F1EE}\u{1F1F7}'; //  🇮🇷 (regional-indicator pair)
const HEART = '❤'; //  ❤
const HEART_VS = '❤️'; //  ❤️ (with VS16)

const tw = (over = {}) => ({ username: 'alice', name: 'Alice', text: 'hello world', ...over });

test('norm: lowercases and strips variation selectors', () => {
  assert.equal(R.norm('ABC'), 'abc');
  assert.equal(R.norm(HEART_VS), R.norm(HEART)); // VS16 must not change the match
  assert.equal(R.norm(null), '');
  assert.equal(R.norm(undefined), '');
});

test('parseTerms: splits lines, trims, drops blanks and # comments', () => {
  assert.deepEqual(R.parseTerms('a\n  b  \n\n# comment\nc'), ['a', 'b', 'c']);
  assert.deepEqual(R.parseTerms(''), []);
});

test('formatTerms <-> parseTerms round-trips non-comment terms', () => {
  const terms = [ROCKET, 'DM for promo', 'x'];
  assert.deepEqual(R.parseTerms(R.formatTerms(terms)), terms);
});

test('hasRules: true only when some list is non-empty', () => {
  assert.equal(R.hasRules({ blockNames: [], blockUsers: [], blockKeywords: [] }), false);
  assert.equal(R.hasRules({}), false);
  assert.equal(R.hasRules({ blockNames: [ROCKET] }), true);
});

test('matchScopes: name is substring, user is exact, text is substring', () => {
  const cfg = { blockNames: [ROCKET], blockUsers: ['bob'], blockKeywords: ['airdrop'] };
  assert.deepEqual(R.matchScopes(tw({ name: 'Ann ' + ROCKET }), cfg), ['name']);
  assert.deepEqual(R.matchScopes(tw({ username: 'bob' }), cfg), ['user']);
  assert.deepEqual(R.matchScopes(tw({ text: 'free airdrop now' }), cfg), ['text']);
  assert.deepEqual(R.matchScopes(tw(), cfg), []);
});

test('matchScopes: handle rule ignores a leading @ and requires an exact match', () => {
  const cfg = { blockUsers: ['@bob'] };
  assert.deepEqual(R.matchScopes(tw({ username: 'bob' }), cfg), ['user']);
  assert.deepEqual(R.matchScopes(tw({ username: 'bobby' }), cfg), []); // not a substring
});

test('matchScopes: flag emoji in a display name matches', () => {
  const cfg = { blockNames: [IR] };
  assert.deepEqual(R.matchScopes(tw({ name: 'Sara ' + IR }), cfg), ['name']);
});

test('matchScopes: VS16-decorated rule matches an un-decorated name', () => {
  const cfg = { blockNames: [HEART_VS] };
  assert.deepEqual(R.matchScopes(tw({ name: 'Lee ' + HEART }), cfg), ['name']);
});

test('entryShouldGo: block mode drops an entry if any tweet matches', () => {
  const cfg = { matchMode: 'block', blockUsers: ['bob'] };
  assert.equal(R.entryShouldGo([tw(), tw({ username: 'bob' })], cfg), true);
  assert.equal(R.entryShouldGo([tw()], cfg), false);
});

test('entryShouldGo: keep mode keeps an entry only if some tweet matches', () => {
  const cfg = { matchMode: 'keep', blockUsers: ['bob'] };
  assert.equal(R.entryShouldGo([tw({ username: 'bob' })], cfg), false); // survives -> not removed
  assert.equal(R.entryShouldGo([tw()], cfg), true); // no match -> removed
});

test('entryShouldGo: no rules never removes anything', () => {
  assert.equal(R.entryShouldGo([tw()], { matchMode: 'block' }), false);
  assert.equal(R.entryShouldGo([tw()], { matchMode: 'keep' }), false);
  assert.equal(R.entryShouldGo([], { matchMode: 'block', blockUsers: ['bob'] }), false);
});

test('termHits: counts matches per term (user exact, name/text substring)', () => {
  const tweets = [
    tw({ name: 'A ' + ROCKET }),
    tw({ name: 'B ' + ROCKET }),
    tw({ username: 'bob' }),
    tw({ text: 'airdrop' }),
  ];
  const cfg = { blockNames: [ROCKET], blockUsers: ['bob'], blockKeywords: ['airdrop', 'nope'] };
  const hits = R.termHits(tweets, cfg);
  const find = (scope, term) => hits.find((h) => h.scope === scope && h.term === term).hits;
  assert.equal(find('name', ROCKET), 2);
  assert.equal(find('user', 'bob'), 1);
  assert.equal(find('text', 'airdrop'), 1);
  assert.equal(find('text', 'nope'), 0);
});

test('buildPredicate: scoped, @handle, bare, and empty', () => {
  const t = tw({ username: 'elon', name: 'Elon ' + ROCKET, text: 'buy airdrop' });
  assert.equal(R.buildPredicate(''), null); // empty query -> null (match everything)
  assert.equal(R.buildPredicate('   '), null);
  assert.equal(R.buildPredicate('name:' + ROCKET)(t), true);
  assert.equal(R.buildPredicate('name:' + ROCKET)(tw({ name: 'plain' })), false);
  assert.equal(R.buildPredicate('text:airdrop')(t), true);
  assert.equal(R.buildPredicate('@elon')(t), true);
  assert.equal(R.buildPredicate('@elon')(tw({ username: 'other' })), false);
  assert.equal(R.buildPredicate('airdrop')(t), true); // bare -> any field
  assert.equal(R.buildPredicate('elon')(t), true);
});

test('sanitizeRules: accepts the exported envelope', () => {
  const r = R.sanitizeRules({
    format: 'x-interceptor-rules',
    version: 1,
    rules: { matchMode: 'keep', blockNames: [ROCKET, '  DM  '], blockUsers: ['@a'], blockKeywords: [] },
  });
  assert.deepEqual(r, { matchMode: 'keep', blockNames: [ROCKET, 'DM'], blockUsers: ['@a'], blockKeywords: [] });
});

test('sanitizeRules: accepts a bare rules object and defaults matchMode', () => {
  const r = R.sanitizeRules({ blockKeywords: ['airdrop'], matchMode: 'nonsense' });
  assert.deepEqual(r, { matchMode: 'block', blockNames: [], blockUsers: [], blockKeywords: ['airdrop'] });
});

test('sanitizeRules: drops non-string and empty terms', () => {
  const r = R.sanitizeRules({ blockNames: ['ok', 5, null, '', '  ', 'x'] });
  assert.deepEqual(r.blockNames, ['ok', 'x']);
});

test('sanitizeRules: rejects non-objects and files with no rule lists', () => {
  assert.throws(() => R.sanitizeRules(42));
  assert.throws(() => R.sanitizeRules(null));
  assert.throws(() => R.sanitizeRules({ matchMode: 'block', foo: 1 }));
});

test('matchedAccounts: groups matching tweets by account with counts and scopes', () => {
  const tweets = [
    tw({ username: 'ann', name: 'Ann ' + ROCKET, text: 'hi' }),
    tw({ username: 'ann', name: 'Ann ' + ROCKET, text: 'again' }),
    tw({ username: 'bob', name: 'Bob', text: 'free airdrop' }),
    tw({ username: 'cara', name: 'Cara', text: 'unrelated' }), // matches nothing
  ];
  const cfg = { matchMode: 'block', blockNames: [ROCKET], blockUsers: [], blockKeywords: ['airdrop'] };
  const accounts = R.matchedAccounts(tweets, cfg);

  assert.deepEqual(accounts.map((a) => a.username), ['ann', 'bob']); // cara excluded, ann first (2 hits)
  assert.equal(accounts[0].count, 2);
  assert.deepEqual(accounts[0].scopes, ['name']);
  assert.deepEqual(accounts[1].scopes, ['text']);
});

test('matchedAccounts: returns nothing when no rules are set', () => {
  const tweets = [tw({ username: 'ann' })];
  assert.deepEqual(R.matchedAccounts(tweets, { matchMode: 'block' }), []);
  assert.deepEqual(R.matchedAccounts([], { blockUsers: ['ann'] }), []);
});

test('matchedAccounts: an account can match on more than one scope', () => {
  const tweets = [tw({ username: 'ann', name: 'Ann ' + ROCKET, text: 'airdrop' })];
  const cfg = { blockNames: [ROCKET], blockKeywords: ['airdrop'] };
  const [acct] = R.matchedAccounts(tweets, cfg);
  assert.deepEqual(acct.scopes.sort(), ['name', 'text']);
});
