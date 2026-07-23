const { norm } = globalThis.__XRules;

const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);

let state = { tweets: [], config: {}, blockedCount: 0 };
let visible = [];

async function load() {
  state = await send({ type: 'getState' });
  $('capture').checked = Boolean(state.config.capture);
  $('hideBlocked').checked = Boolean(state.config.hideBlocked);
  render();
}

/** `name:🚀` / `text:airdrop` / `@handle` / bare term (matches any field). */
function buildPredicate(raw) {
  const query = String(raw).trim();
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

function render() {
  const predicate = buildPredicate($('search').value);
  const matches = predicate ? state.tweets.filter(predicate) : state.tweets;
  visible = matches;

  $('count').textContent = predicate
    ? `${matches.length}/${state.tweets.length}`
    : state.tweets.length;
  $('users').textContent = new Set(matches.map((t) => t.username)).size;
  $('blocked').textContent = state.blockedCount;

  const list = $('list');
  list.replaceChildren();

  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = state.tweets.length
      ? 'No matches.'
      : 'Nothing captured yet — open or scroll x.com.';
    list.append(empty);
    return;
  }

  for (const tweet of matches.slice(0, 200)) {
    const row = document.createElement('div');
    row.className = 'tweet';

    const who = document.createElement('div');
    who.className = 'who';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = tweet.name || tweet.username;

    const handle = document.createElement('a');
    handle.className = 'handle';
    handle.href = tweet.url;
    handle.target = '_blank';
    handle.rel = 'noreferrer';
    handle.textContent = `@${tweet.username}`;

    who.append(name, handle);

    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = tweet.text;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `♥ ${tweet.likeCount} · ↺ ${tweet.retweetCount} · ${tweet.createdAt || ''}`;

    row.append(who, text, meta);
    list.append(row);
  }
}

$('search').addEventListener('input', render);

$('capture').addEventListener('change', async (e) => {
  ({ config: state.config } = await send({
    type: 'setConfig',
    config: { capture: e.target.checked },
  }));
});

$('hideBlocked').addEventListener('change', async (e) => {
  ({ config: state.config } = await send({
    type: 'setConfig',
    config: { hideBlocked: e.target.checked },
  }));
});

// A standalone window rather than a tab — the dashboard is a working surface
// you keep open next to the timeline you're tuning rules against.
$('dashboard').addEventListener('click', async () => {
  await chrome.windows.create({
    url: chrome.runtime.getURL('src/options.html'),
    type: 'popup',
    width: 1180,
    height: 860,
  });
  window.close();
});

// Exports what's on screen, so a `name:🚀` search doubles as an extraction query.
$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(visible, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'x-tweets.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

load();
