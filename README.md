# x-interceptor

A Chrome extension that reads X/Twitter's GraphQL traffic, extracts structured
tweet and account data, and can drop unwanted posts from the payload **before
the page renders them**.

No scraping the DOM, no flicker from post-render removal — filtered posts never
reach React at all.

## Features

- **Structured capture** — tweets, authors, engagement counts and timestamps
  pulled straight from the API responses the page is already fetching
- **Pre-render filtering** — rules are applied to the JSON in flight, so blocked
  posts are never rendered
- **Blocklist or allowlist** — hide what matches, or show *only* what matches
- **Match on display name**, handle, or tweet text — including emoji, so
  `🚀` or `❤️` in a display name is a first-class rule
- **Live rule preview** — score draft rules against everything already captured
  before saving them
- **Scoped search + JSON export** over the capture store
- **Fully local** — no servers, no telemetry, no network requests of its own

## Install

Not on the Chrome Web Store. Load it unpacked:

1. Clone this repo
2. Open `chrome://extensions` and enable **Developer mode**
3. **Load unpacked** → select the repo folder
4. Open [x.com](https://x.com) and scroll

Reload the extension *and* the X tab after pulling changes — the hook only
installs at `document_start`.

Chrome 111+ (or any current Chromium: Edge, Brave, Vivaldi). Firefox is not
supported; it lacks `world: "MAIN"` content scripts.

## Usage

Click the toolbar icon for a compact viewer, or **Dashboard ↗** for the full
window — rule editor on the left, live preview on the right. The dashboard is
also under right-click → Options.

### Rules

Three scopes, each **one term per line**. Blank lines and `#` comments are
ignored, so lists can be grouped and annotated:

```
🚀
💎

# promo spam
DM for promo
link in bio
```

| Scope | Matching |
|---|---|
| Display name contains | substring |
| Handles | exact |
| Tweet text contains | substring |

Mode is *Hide tweets that match* (blocklist) or *Show only tweets that match*
(allowlist — useful for building a feed of a single cohort). With no rules set
nothing is filtered in either mode, so allowlist mode can't accidentally empty
your timeline.

Rules only take effect on live traffic once **Filter before render** is on.

### Preview

The preview scores rules **as typed**, before saving, against everything already
captured:

- How many captured tweets the draft would hide vs. show, with a percentage
- Row highlighting — red for removed, green for kept — and a badge per row
  naming which scope matched
- **All / Matched / Unmatched** tabs, composable with the search box
- A per-term hit table, with zero-hit terms called out — that's how you catch an
  emoji that doesn't actually appear in any captured display name before the
  rule goes live

Nothing applies until **Save rules**. The page updates live from storage, so you
can scroll a timeline in another window and watch the sample grow; an
in-progress edit is never overwritten by that sync.

### Search

| Query | Matches |
|---|---|
| `name:🚀` | display name contains the emoji |
| `name:DM for promo` | display name contains the phrase |
| `text:airdrop` | tweet body |
| `@elonmusk` | handle |
| `airdrop` | any of the three |

**Export** writes whatever is on screen — search and view tab included — so
`name:🚀` doubles as an extraction query.

## How it works

X is a SPA: every timeline, thread, profile and search result arrives as JSON
from `https://x.com/i/api/graphql/<queryId>/<OperationName>`. The DOM is a render
of those payloads, so intercepting them yields structured data instead of
scraped markup — and rewriting one before it resolves changes what gets
rendered.

```
┌─ MAIN world ──────────────┐   postMessage   ┌─ ISOLATED world ─┐   runtime   ┌──────────────┐
│ inject.js                 │ ──────────────► │ bridge.js        │ ──────────► │ background.js│
│ patches fetch + XHR       │ ◄────────────── │ relays config    │             │ dedupe+store │
└───────────────────────────┘                 └──────────────────┘             └──────────────┘
```

Two content scripts are required: a MAIN-world script can touch the page's real
`window` but has **no** `chrome.*` APIs, while an ISOLATED one has the APIs but
its own separate `window`.

### Why not `chrome.webRequest`?

| Approach | Response body | Notes |
|---|---|---|
| `chrome.webRequest` | ❌ | MV3 removed blocking and body access |
| `declarativeNetRequest` | ❌ | Block/redirect only |
| `chrome.debugger` | ✅ | Works, but shows the "is debugging this browser" banner |
| **MAIN-world `fetch` patch** | ✅ | Also allows rewriting the payload |

### Layout

| File | World | Role |
|---|---|---|
| `src/rules.js` | MAIN + pages | Shared matching: normalization, term parsing, scope matching |
| `src/inject.js` | MAIN | Patches `fetch` and `XMLHttpRequest`; extracts and prunes |
| `src/bridge.js` | ISOLATED | The only script with `chrome.*` access; relays both ways |
| `src/background.js` | SW | Dedupes by tweet id, buffered writes to `chrome.storage.local` |
| `src/popup.*` | — | Compact viewer |
| `src/options.*` | — | Dashboard: rule editor and preview |

`rules.js` loads both into the MAIN world (ahead of `inject.js`) and into the
extension pages, so the dashboard preview scores rules with the exact code that
prunes the timeline — the two can't drift.

### Extracted shape

```js
{
  id, username, name, userId, verified,
  text, lang, createdAt,
  replyCount, retweetCount, likeCount, quoteCount,
  isRetweet, isReply, url
}
```

## Implementation notes

The things that break if you get them wrong:

- **`response.clone()` before reading.** Consuming the original stream leaves the
  page with an empty body and silently kills the timeline.
- **`run_at: document_start`.** Inject any later and X's bundle has already
  captured the original `fetch`; the hook never fires.
- **Match on operation name, not query id.** The `<queryId>` hash rotates on
  every X deploy; `HomeTimeline`, `TweetDetail`, `UserTweets`, `SearchTimeline`
  do not.
- **Walk the JSON, don't index paths.** Extraction recurses looking for
  `__typename === 'Tweet'` rather than hardcoding
  `timeline_v2.timeline.instructions[…]`, which differs per endpoint and drifts
  between releases. This also handles the `TweetWithVisibilityResults` wrapper
  (which nests the real tweet a level deeper) for free.
- **Long posts live in `note_tweet`**, not `legacy.full_text` — the latter is
  truncated at 280 chars.
- **User fields moved.** Newer payloads put `screen_name`/`name` on `user.core`;
  older ones use `user.legacy`. Both are read.
- **XHR is trapped by property shadowing**, not a `load` listener. The page
  registers its handlers before `send()`, so a listener added by the hook would
  run *after* the body was already read. Shadowing `responseText`/`response` on
  the instance returns the processed payload regardless of handler order.
- **Emoji need normalizing before comparison.** Both sides are NFC-normalized and
  stripped of variation selectors (U+FE0E/U+FE0F), so `❤️` pasted from one source
  matches `❤` served by another. Multi-codepoint emoji — flags, skin-tone
  variants, ZWJ sequences — compare fine as plain substrings once that's
  handled.
- **Identify entries by content, not by `entryId` prefix.** X names them
  differently per surface (`tweet-`, `profile-conversation-`,
  `conversationthread-`, …) and adds new ones without notice, so a prefix
  whitelist silently stops matching. Pruning instead asks "does this entry
  contain a tweet?" — cursors and "who to follow" modules harvest empty and are
  always kept, which keeps pagination safe for free.
- **Replies live in `items`, not `entries`.** Conversation threads are modules
  with their own nested item list; pruning only `entries` leaves every reply
  untouched. Pruning runs depth-first so one blocked reply costs the reply
  rather than the whole thread, and a module emptied by that pass is dropped so
  it can't render as a blank card.
- **Retweets carry two authors.** The outer tweet is the retweeter, with the
  original nested under `legacy.retweeted_status_result`. Both are harvested, so
  a rule matching either the retweeter or the original author removes the entry.
- **Config must be pulled, not just pushed.** The MAIN and ISOLATED worlds are
  injected independently at `document_start` with no ordering guarantee, so
  whichever runs second misses the other's opening message. The hook requests
  its config and retries until answered — a lost config leaves `hideBlocked`
  false, which silently disables filtering while capture (defaulting on) keeps
  working, making it look like the rules are wrong.
- **Page CSP does not apply.** MAIN-world content scripts are exempt, unlike a
  manually appended `<script src>`.

## Troubleshooting

The dashboard's status bar reports what the in-page hook actually believes,
which is the fastest way to tell a broken rule from a rule that never arrived:

```
Hook: UserTweets · 20 tweets · 3 pruned · 4 rules live · 2s ago — filtering active
```

| Status | Meaning |
|---|---|
| *Hook has not reported yet* | No x.com tab is running the hook. It only installs at page load — reload the tab. |
| *installed, no payload fetched yet* | The hook is alive and holds your rules; the tab just hasn't fetched anything since. Scroll it. |
| *hook never received config* | The content script is running on stale defaults. Reload the tab. |
| *rules not live in the page yet* | Rules are saved here but the open tab predates them. Reload the tab. |
| *no saved rules* | The editor has unsaved edits — press **Save rules**. The preview scores drafts, so it looks like it's working before you save. |

Two things that look like bugs but aren't:

- **One term per line.** `💚🖤❤️` on a single line is one term matching that exact
  contiguous sequence, not three alternatives. Put each emoji on its own line.
  The per-term hit table shows `0` for terms that match nothing captured.
- **Filtering applies to newly fetched payloads.** Already-rendered posts stay
  until the tab reloads.
- **"filtered live" and the preview count different things.** The header counts
  entries actually removed from live payloads since install; the preview scores
  your rules against the whole capture store, most of which was captured before
  filtering was on. The preview number being far larger is expected.

## Privacy

Everything stays in `chrome.storage.local` on your machine. The extension makes
no network requests, contacts no server, and ships no analytics. Export is a
local file download. Uninstalling, or **Clear store**, removes the data.

## Limits

- Only sees what the tab actually requests — this is not a crawler
- Capture store is capped at 5,000 tweets, newest first
- Filtering applies to newly loaded payloads; already-rendered posts stay put
  until the tab reloads
- X ships schema changes without notice; extraction is written defensively but
  can still need updating

## Disclaimer

Unofficial and unaffiliated with X Corp. It reads responses your own browser
session already received, on your own machine. Automating or modifying a service
may conflict with its terms of service — that's on you to evaluate. Provided as
is, with no warranty.
