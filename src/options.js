const {
  DEFAULT_CONFIG,
  norm,
  parseTerms,
  formatTerms,
  hasRules,
  matchScopes,
  termHits,
  buildPredicate,
  sanitizeRules,
} = globalThis.__XRules;

const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);

let tweets = [];
let saved = { ...DEFAULT_CONFIG };
let blockedCount = 0;
let lastStatus = null;
let view = 'all';
let visible = [];

const RULE_FIELDS = {
  blockNames: 'blockNames',
  blockUsers: 'blockUsers',
  blockKeywords: 'blockKeywords',
};

/** The rules as currently typed — the preview scores these, not what's saved. */
function draftConfig() {
  return {
    ...saved,
    matchMode: $('matchMode').value,
    blockNames: parseTerms($('blockNames').value),
    blockUsers: parseTerms($('blockUsers').value),
    blockKeywords: parseTerms($('blockKeywords').value),
  };
}

function isDirty() {
  const draft = draftConfig();
  return (
    draft.matchMode !== saved.matchMode ||
    Object.keys(RULE_FIELDS).some(
      (key) => (draft[key] || []).join('\n') !== (saved[key] || []).join('\n')
    )
  );
}

// ------------------------------------------------------------------ load/store

async function load() {
  const state = await send({ type: 'getState' });
  tweets = state.tweets || [];
  saved = { ...DEFAULT_CONFIG, ...state.config };
  blockedCount = state.blockedCount || 0;
  lastStatus = state.lastStatus || null;

  $('capture').checked = Boolean(saved.capture);
  $('hideBlocked').checked = Boolean(saved.hideBlocked);
  $('matchMode').value = saved.matchMode || 'block';
  for (const key of Object.keys(RULE_FIELDS)) $(key).value = formatTerms(saved[key]);

  render();
}

// Keeps the dashboard live while a timeline is being scrolled in another tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.tweets) tweets = changes.tweets.newValue || [];
  if (changes.blockedCount) blockedCount = changes.blockedCount.newValue || 0;
  if (changes.lastStatus) {
    lastStatus = changes.lastStatus.newValue || null;
    renderHookStatus();
  }
  if (changes.config) {
    const next = { ...DEFAULT_CONFIG, ...changes.config.newValue };
    // Never stomp rules the user is mid-edit; only sync the header toggles.
    saved = { ...next, ...(isDirty() ? pickRules(saved) : {}) };
    $('capture').checked = Boolean(saved.capture);
    $('hideBlocked').checked = Boolean(saved.hideBlocked);
  }
  if (changes.tweets || changes.blockedCount || changes.config) render();
});

const pickRules = (config) => ({
  matchMode: config.matchMode,
  blockNames: config.blockNames,
  blockUsers: config.blockUsers,
  blockKeywords: config.blockKeywords,
});

// --------------------------------------------------------------------- render

function render() {
  const draft = draftConfig();
  const active = hasRules(draft);

  const scored = tweets.map((tweet) => {
    const scopes = active ? matchScopes(tweet, draft) : [];
    return { tweet, scopes, matched: scopes.length > 0 };
  });

  renderSummary(scored, draft, active);
  renderTermHits(draft);
  renderDirty();
  renderHookStatus();

  const predicate = buildPredicate($('search').value);
  let rows = predicate ? scored.filter((r) => predicate(r.tweet)) : scored;
  if (view === 'matched') rows = rows.filter((r) => r.matched);
  else if (view === 'rest') rows = rows.filter((r) => !r.matched);

  visible = rows.map((r) => r.tweet);
  renderList(rows, draft, active);
}

function renderSummary(scored, draft, active) {
  $('statTweets').textContent = tweets.length.toLocaleString();
  $('statUsers').textContent = new Set(tweets.map((t) => t.username)).size.toLocaleString();
  $('statBlocked').textContent = blockedCount.toLocaleString();

  const summary = $('summary');
  summary.replaceChildren();

  if (!tweets.length) {
    summary.append(pill('Nothing captured yet — scroll x.com in another tab', 'dim'));
    return;
  }
  if (!active) {
    summary.append(pill('No rules set — preview idle', 'dim'));
    return;
  }

  const matched = scored.filter((r) => r.matched).length;
  const hiding = draft.matchMode === 'keep' ? tweets.length - matched : matched;
  const surviving = tweets.length - hiding;
  const pct = ((hiding / tweets.length) * 100).toFixed(1);

  summary.append(
    document.createTextNode('Against the captured sample: '),
    pill(`${hiding.toLocaleString()} hidden (${pct}%)`, 'hit'),
    pill(`${surviving.toLocaleString()} shown`, 'keep'),
    document.createTextNode(
      $('hideBlocked').checked
        ? ''
        : '— preview only, "Filter before render" is off'
    )
  );
}

const ago = (ts) => {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
};

/**
 * What the in-page hook actually believes, as opposed to what's saved here.
 * A saved rule that never reached the content script looks identical to a rule
 * that matches nothing, and this is the only thing that tells them apart.
 */
function renderHookStatus() {
  const dot = document.querySelector('#hookbar .dot');
  const text = $('hookText');
  dot.className = 'dot';

  const version = chrome.runtime.getManifest().version;

  if (!lastStatus) {
    dot.classList.add('warn');
    text.textContent =
      `Extension v${version} · hook has not reported yet — open or reload an x.com tab ` +
      '(the hook only installs at page load, so an already-open tab keeps running the old code).';
    return;
  }

  if (lastStatus.version && lastStatus.version !== version) {
    dot.classList.add('warn');
    text.textContent =
      `Extension v${version} but the page is running v${lastStatus.version} — ` +
      'reload the x.com tab to pick up the new code.';
    return;
  }

  const parts = lastStatus.op
    ? [lastStatus.op, `${lastStatus.tweets} tweets`, `${lastStatus.removed} pruned`]
    : ['installed, no payload fetched yet'];

  parts.push(`${lastStatus.rules} rules live`, ago(lastStatus.at), `v${version}`);

  let verdict = '';
  if (!lastStatus.configReceived) {
    dot.classList.add('warn');
    verdict = 'hook never received config, reload the x.com tab';
  } else if (saved.hideBlocked && !lastStatus.filtering) {
    dot.classList.add('warn');
    verdict =
      saved.blockNames?.length || saved.blockUsers?.length || saved.blockKeywords?.length
        ? 'rules not live in the page yet, reload the x.com tab'
        : 'no saved rules (did you press Save?)';
  } else if (lastStatus.filtering) {
    dot.classList.add('ok');
    verdict = 'filtering active';
  }

  text.textContent = `Hook: ${parts.join(' · ')}${verdict ? ` — ${verdict}` : ''}`;
}

function pill(text, cls) {
  const el = document.createElement('span');
  el.className = `pill ${cls || ''}`.trim();
  el.textContent = text;
  return el;
}

function renderTermHits(draft) {
  const body = $('termHits');
  body.replaceChildren();

  const rows = termHits(tweets, draft);
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.style.color = 'var(--muted)';
    td.textContent = 'No terms yet.';
    tr.append(td);
    body.append(tr);
    return;
  }

  for (const { scope, term, hits } of rows) {
    const tr = document.createElement('tr');

    const scopeCell = document.createElement('td');
    scopeCell.style.color = 'var(--muted)';
    scopeCell.style.width = '3.5em';
    scopeCell.textContent = scope;

    const termCell = document.createElement('td');
    termCell.className = 'term';
    termCell.textContent = term;

    const hitCell = document.createElement('td');
    hitCell.className = hits ? 'n' : 'n zero';
    hitCell.textContent = hits;
    hitCell.title = hits ? '' : 'Matches nothing in the captured sample';

    tr.append(scopeCell, termCell, hitCell);
    body.append(tr);
  }
}

function renderDirty() {
  const dirty = isDirty();
  $('save').disabled = !dirty;
  $('revert').disabled = !dirty;
  $('dirty').textContent = dirty ? 'Unsaved changes' : '';
}

function renderList(rows, draft, active) {
  const list = $('list');
  list.replaceChildren();

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = tweets.length ? 'No tweets match this view.' : 'Nothing captured yet.';
    list.append(empty);
    return;
  }

  const hidesOnMatch = draft.matchMode === 'block';

  for (const { tweet, scopes, matched } of rows.slice(0, 500)) {
    const row = document.createElement('div');
    row.className = 'tweet';
    if (active && matched) row.classList.add(hidesOnMatch ? 'match-hide' : 'match-keep');
    else if (active && !hidesOnMatch) row.classList.add('match-hide');

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

    if (scopes.length) {
      const badges = document.createElement('span');
      badges.className = 'scopes';
      for (const scope of scopes) {
        const badge = document.createElement('span');
        badge.className = 'scope';
        badge.textContent = scope;
        badges.append(badge);
      }
      who.append(badges);
    }

    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = tweet.text;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `♥ ${tweet.likeCount} · ↺ ${tweet.retweetCount} · ${tweet.createdAt || ''}`;

    row.append(who, text, meta);
    list.append(row);
  }

  if (rows.length > 500) {
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent = `Showing first 500 of ${rows.length.toLocaleString()} — export for the full set.`;
    list.append(note);
  }
}

// ---------------------------------------------------------------------- events

const debounce = (fn, ms) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};

const onRuleInput = debounce(render, 150);
for (const key of Object.keys(RULE_FIELDS)) {
  $(key).addEventListener('input', onRuleInput);
}
$('matchMode').addEventListener('change', render);
$('search').addEventListener('input', debounce(render, 120));

$('view').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-view]');
  if (!button) return;
  view = button.dataset.view;
  for (const b of $('view').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b === button));
  }
  render();
});

$('capture').addEventListener('change', async (e) => {
  const { config } = await send({ type: 'setConfig', config: { capture: e.target.checked } });
  saved = { ...saved, capture: config.capture };
});

$('hideBlocked').addEventListener('change', async (e) => {
  const { config } = await send({
    type: 'setConfig',
    config: { hideBlocked: e.target.checked },
  });
  saved = { ...saved, hideBlocked: config.hideBlocked };
  render();
});

$('save').addEventListener('click', async () => {
  const draft = draftConfig();
  const { config } = await send({ type: 'setConfig', config: pickRules(draft) });
  saved = { ...DEFAULT_CONFIG, ...config };
  render();
});

$('revert').addEventListener('click', () => {
  $('matchMode').value = saved.matchMode || 'block';
  for (const key of Object.keys(RULE_FIELDS)) $(key).value = formatTerms(saved[key]);
  render();
});

$('clear').addEventListener('click', async () => {
  if (!confirm(`Delete all ${tweets.length.toLocaleString()} captured tweets?`)) return;
  await send({ type: 'clear' });
  await load();
});

// Exports what's on screen, so a `name:🚀` search doubles as an extraction query.
$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(visible, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'x-tweets.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ------------------------------------------------------------ export/import rules

const RULES_FORMAT = 'x-interceptor-rules';

const download = (filename, text) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

function setIo(message, isError = false) {
  const el = $('rulesIo');
  el.textContent = message;
  el.style.color = isError ? 'var(--hit)' : 'var(--muted)';
}

// Exports the rules as currently typed (the draft), so "edit then export" works
// without saving first. Only the rule set travels — never captured tweets or the
// capture/filter toggles.
$('exportRules').addEventListener('click', () => {
  const draft = draftConfig();
  const rules = pickRules(draft);
  const count = rules.blockNames.length + rules.blockUsers.length + rules.blockKeywords.length;
  download(
    'x-interceptor-rules.json',
    JSON.stringify({ format: RULES_FORMAT, version: 1, exportedAt: new Date().toISOString(), rules }, null, 2)
  );
  setIo(`Exported ${count} term${count === 1 ? '' : 's'}.`);
});

$('importRules').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', (event) => {
  const file = event.target.files[0];
  event.target.value = ''; // let the same file re-trigger 'change' next time
  if (!file) return;

  const reader = new FileReader();
  reader.onerror = () => setIo('Could not read that file.', true);
  reader.onload = () => {
    let rules;
    try {
      rules = sanitizeRules(JSON.parse(reader.result));
    } catch (err) {
      setIo(err.message || 'Invalid rules file.', true);
      return;
    }
    // Import loads into the editor as an unsaved draft — the user sees the
    // preview and Saves (or Reverts). Guard an in-progress edit first.
    if (isDirty() && !confirm('Replace your unsaved rule edits with the imported file?')) return;

    $('matchMode').value = rules.matchMode;
    $('blockNames').value = formatTerms(rules.blockNames);
    $('blockUsers').value = formatTerms(rules.blockUsers);
    $('blockKeywords').value = formatTerms(rules.blockKeywords);
    render();

    const total = rules.blockNames.length + rules.blockUsers.length + rules.blockKeywords.length;
    setIo(`Imported ${total} term${total === 1 ? '' : 's'} — review the preview and Save.`);
  };
  reader.readAsText(file);
});

window.addEventListener('beforeunload', (event) => {
  if (!isDirty()) return;
  event.preventDefault();
  event.returnValue = '';
});

load();
