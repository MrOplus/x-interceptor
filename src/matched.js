const { DEFAULT_CONFIG, matchedAccounts } = globalThis.__XRules;

const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);

let tweets = [];
let saved = { ...DEFAULT_CONFIG };
let xActions = {}; // { [userId]: 'block' | 'mute' } — accounts already acted on

async function load() {
  const state = await send({ type: 'getState' });
  tweets = state.tweets || [];
  saved = { ...DEFAULT_CONFIG, ...state.config };
  xActions = state.xActions || {};
  render();
}

// Stay current while a timeline is scrolled or rules change elsewhere.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.tweets) tweets = changes.tweets.newValue || [];
  if (changes.config) saved = { ...DEFAULT_CONFIG, ...changes.config.newValue };
  if (changes.xActions) xActions = changes.xActions.newValue || {};
  if (changes.tweets || changes.config || changes.xActions) render();
});

/**
 * Performs a real, user-initiated block/mute on the account, via the user's own
 * X session. Reversible on X. One deliberate action per click — there is no
 * bulk "act on all" here by design.
 */
async function doAction(kind, acct, btn) {
  if (!acct.userId) return;
  const verb = kind === 'block' ? 'Block' : 'Mute';
  if (
    !confirm(
      `${verb} @${acct.username} on X?\n\nThis performs a real ${kind} on your own X account. ` +
        `You can undo it anytime from X.`
    )
  ) {
    return;
  }

  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '…';

  let resp;
  try {
    resp = await send({ type: 'xaction', kind, userId: acct.userId, username: acct.username });
  } catch (err) {
    resp = { ok: false, error: err?.message || 'the extension did not respond' };
  }

  if (resp?.ok) {
    xActions = { ...xActions, [acct.userId]: kind };
    render();
  } else {
    const reason = resp?.error || 'no response — reload the x.com tab and this page, then retry';
    console.warn('[x-interceptor] xaction failed:', reason);
    // Show it inline (persistent + copyable) rather than a transient alert.
    const row = btn.closest('.acct');
    let err = row.querySelector('.err');
    if (!err) {
      err = document.createElement('div');
      err.className = 'err';
      row.querySelector('.who').append(err);
    }
    err.textContent = `Couldn’t ${kind}: ${reason}`;
    btn.disabled = false;
    btn.textContent = original;
  }
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

  const acted = xActions[acct.userId]; // 'block' | 'mute' | undefined

  if (acted) {
    const done = document.createElement('span');
    done.className = 'done';
    done.textContent = acted === 'block' ? 'Blocked ✓' : 'Muted ✓';
    actions.append(done);
  } else if (!acct.userId) {
    const na = document.createElement('span');
    na.className = 'hint';
    na.textContent = 'no id';
    na.title = 'This account was captured without a user id, so it can’t be actioned.';
    actions.append(na);
  } else {
    const muteBtn = document.createElement('button');
    muteBtn.className = 'mute';
    muteBtn.textContent = 'Mute';
    muteBtn.title = 'Mute on X (real action, reversible)';
    muteBtn.addEventListener('click', () => doAction('mute', acct, muteBtn));

    const blockBtn = document.createElement('button');
    blockBtn.className = 'block';
    blockBtn.textContent = 'Block';
    blockBtn.title = 'Block on X (real action, reversible)';
    blockBtn.addEventListener('click', () => doAction('block', acct, blockBtn));

    actions.append(muteBtn, blockBtn);
  }

  const openX = document.createElement('a');
  openX.className = 'btn';
  openX.href = `https://x.com/${acct.username}`;
  openX.target = '_blank';
  openX.rel = 'noreferrer';
  openX.textContent = 'Open ↗';
  openX.title = 'Open the profile on X';

  actions.append(openX);
  row.append(who, count, actions);
  return row;
}

$('search').addEventListener('input', render);

load();
