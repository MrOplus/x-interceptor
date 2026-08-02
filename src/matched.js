const { DEFAULT_CONFIG, matchedAccounts } = globalThis.__XRules;

const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);

let tweets = [];
let saved = { ...DEFAULT_CONFIG };

const blockedSet = () => new Set((saved.blockUsers || []).map((u) => u.replace(/^@/, '').toLowerCase()));
const isBlocked = (username) => blockedSet().has(username.toLowerCase());

async function load() {
  const state = await send({ type: 'getState' });
  tweets = state.tweets || [];
  saved = { ...DEFAULT_CONFIG, ...state.config };
  render();
}

// Stay current while a timeline is scrolled or rules change elsewhere.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.tweets) tweets = changes.tweets.newValue || [];
  if (changes.config) saved = { ...DEFAULT_CONFIG, ...changes.config.newValue };
  if (changes.tweets || changes.config) render();
});

/** Adds a handle to the extension's own block list — a local filter, nothing
 *  more. It hides the account from your captured/filtered view; it does not
 *  contact X or act on the account. */
async function blockLocally(username) {
  if (isBlocked(username)) return;
  const next = [...(saved.blockUsers || []), username];
  const { config } = await send({ type: 'setConfig', config: { blockUsers: next } });
  saved = { ...DEFAULT_CONFIG, ...config };
  render();
}

function render() {
  const query = $('search').value.trim().toLowerCase().replace(/^@/, '');
  let accounts = matchedAccounts(tweets, saved);
  if (query) {
    accounts = accounts.filter(
      (a) => a.username.toLowerCase().includes(query) || a.name.toLowerCase().includes(query)
    );
  }

  $('count').textContent = accounts.length;
  const list = $('list');
  list.replaceChildren();

  if (!accounts.length) {
    const note = document.createElement('div');
    note.className = 'note';
    if (!(saved.blockNames?.length || saved.blockUsers?.length || saved.blockKeywords?.length)) {
      note.innerHTML =
        'No rules set yet. Add rules in the <strong>dashboard</strong>, then the accounts they match show up here.';
    } else {
      note.textContent = tweets.length
        ? 'No captured accounts match your rules yet — scroll x.com to capture more.'
        : 'Nothing captured yet — open or scroll x.com.';
    }
    list.append(note);
    return;
  }

  for (const acct of accounts) list.append(renderAccount(acct));
}

function renderAccount(acct) {
  const row = document.createElement('div');
  row.className = 'acct';

  const who = document.createElement('div');
  who.className = 'who';

  const line1 = document.createElement('div');
  line1.className = 'line1';

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = acct.name || acct.username;
  line1.append(name);

  if (acct.verified) {
    const v = document.createElement('span');
    v.className = 'verified';
    v.textContent = '✓';
    v.title = 'Verified';
    line1.append(v);
  }

  const handle = document.createElement('a');
  handle.className = 'handle';
  handle.href = `https://x.com/${acct.username}`;
  handle.target = '_blank';
  handle.rel = 'noreferrer';
  handle.textContent = `@${acct.username}`;
  line1.append(handle);

  const scopes = document.createElement('span');
  scopes.className = 'scopes';
  for (const s of acct.scopes) {
    const badge = document.createElement('span');
    badge.className = 'scope';
    badge.textContent = s;
    scopes.append(badge);
  }
  line1.append(scopes);

  const sample = document.createElement('div');
  sample.className = 'sample';
  sample.textContent = acct.sample;

  who.append(line1, sample);

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = `${acct.count} matched`;

  const actions = document.createElement('div');
  actions.className = 'actions';

  const blockBtn = document.createElement('button');
  if (isBlocked(acct.username)) {
    blockBtn.className = 'blocked';
    blockBtn.textContent = 'Blocked';
    blockBtn.disabled = true;
  } else {
    blockBtn.className = 'block';
    blockBtn.textContent = 'Block';
    blockBtn.title = 'Add to this extension’s filter (local only)';
    blockBtn.addEventListener('click', () => blockLocally(acct.username));
  }

  const openX = document.createElement('a');
  openX.className = 'btn';
  openX.href = `https://x.com/${acct.username}`;
  openX.target = '_blank';
  openX.rel = 'noreferrer';
  openX.textContent = 'Open on X ↗';
  openX.title = 'Block or mute natively on X yourself';

  actions.append(blockBtn, openX);
  row.append(who, count, actions);
  return row;
}

$('search').addEventListener('input', render);

load();
