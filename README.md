# yahoo-football-draft-assistant

Keeps your Yahoo fantasy football draft queue full of the players worth taking,
ranked by projected-points surplus rather than ADP. Works in mock drafts and real
drafts.

It never picks for you, with one exception: when your two back-to-back picks
would otherwise both go to the same position, it steps in with a second left on
the clock. Everything else is queue management — Yahoo drafts the top of your
queue if your clock expires, so the queue is the safety net.

Two inputs feed one valuation: NFL team strength and playoff schedule from ESPN,
gathered before the draft, and the live player pool read out of the draft room the
moment it opens. The room publishes projected points **already scored under your
league's rules**, so the assistant never has to be told your scoring settings.

---

## Requirements

- **Python 3** — for the local file server. Standard library only.
- **Chrome** (or another Chromium browser, e.g. Edge) — the loader is a bookmark
  or a line pasted into the DevTools console.
- **Node 18+** — *optional*, only to refresh the ESPN team data. A generated copy
  ships in the repo, so you can skip this.

No browser extension. No npm install. No API keys.

---

## Install and run

```bash
git clone https://github.com/jdfree/yahoo-football-draft-assistant.git
cd yahoo-football-draft-assistant
./start.sh
```

`start.sh` stops any server left over from a previous draft, starts a new one,
and prints the one line you need. Stop it with Ctrl-C, or `./start.sh stop`.
Pass a port if 8765 is taken: `./start.sh 9000`.

Then load it into the draft room. **The bookmark is the easy way** — make it once
and click it in every draft.

> **Do not paste this into the address bar.** Chrome strips the `javascript:`
> prefix and searches for the rest. It only works as a bookmark.

1. Show the bookmarks bar — **⌘⇧B** (**Ctrl+Shift+B** on Windows/Linux).
2. Right-click an empty spot on the bar and choose **"Add page…"**.
3. Name it anything, e.g. `Draft assistant`.
4. Paste this as the **URL**, then save:

```
javascript:(function(){var s=document.createElement('script');s.src='http://localhost:8765/bootstrap.js';document.body.appendChild(s);})()
```

If the Add-page dialog strips the prefix as well, save the bookmark with any
placeholder URL, then right-click it, choose **Edit**, and paste there — the edit
dialog accepts it.

Now open your draft room, wait for the board, and click the bookmark. **Chrome
will ask permission to reach localhost — click "Allow".**

Or do the same thing from the console (F12), without the `javascript:` prefix:

```js
var s=document.createElement('script');s.src='http://localhost:8765/bootstrap.js';document.body.appendChild(s);
```

Chrome makes you type `allow pasting` into the console once before it accepts a
paste. The bookmark route skips that.

That's the whole setup. **Your slot and league size are read from the room**, so
there is nothing to configure — the slot comes from the URL and the team count is
counted off the draft-order strip, and both override anything in the config.

It runs live immediately. To watch it without touching your queue, paste this
first:

```js
window.YS_CONFIG={DRY_RUN:true};
```

Load it as early as you can. It reads the whole player pool once at startup, and
it will not touch the queue while your own clock is running — so arriving with two
picks to go means your first turn goes unassisted.

### What you should see

- **A floors strip** across the bottom of the window — the projected best survivor
  at each position at your next-but-two pick. Every valuation rests on these:
  ```
  FLOORS R5 pick 70  QB 269.6 | RB 157.5 | WR 163.6 | TE 134.7 | K 136.2 | DEF 123.8 | FLEX 163.6
  ```
- **A green surplus figure** under each queued player — his projection minus the
  bar for the slot he'd fill. Negative values are normal and meaningful: they say
  the board will still offer someone better later.
- **A queue that stays still.** Between rebuilds it only replaces players who were
  actually drafted. If it is churning every few seconds, something is wrong.

---

## Refreshing the ESPN data (optional)

```bash
node fetch-team-context.js                      # defaults to playoff weeks 15,16,17
node fetch-team-context.js --playoffs 14,15,16  # match your league
```

Writes `team-context.json` and `team-context.gen.js`; the loader reads the latter.
A generated copy is committed, so this is only needed to pick up preseason
movement or to change playoff weeks. Run it the morning of the draft if you care.

It scrapes [ESPN FPI](https://www.espn.com/nfl/fpi) and the
[schedule grid](https://www.espn.com/nfl/schedulegrid), then **validates itself** —
272 games, exactly one bye per team, every matchup reciprocated with opposite
home/away — and fails loudly rather than emitting a half-parsed table.

Playoff difficulty is `opponent defensive EPA − opponent offensive EPA`, averaged
over your playoff weeks. A strong opposing defense hurts; a strong opposing
*offense* helps, because it forces a competitive, high-possession game. Facing a
good all-round team can therefore grade as an easy fantasy matchup — that is the
metric working as intended.

```
  # Team   FPI  Bye  Diffcty  Modifier  Opponents
  -- easiest --
  1 CHI    1.2   10  -3.167    1.0500   @BUF GB DET
 32 ARI   -5.2   14   2.133    0.9500   NYJ @NO LV
```

One quirk: ESPN serves a bot-challenge page to clients claiming to be Chrome, and
the real HTML to anything identifying honestly as a script. The script sends its
own user-agent. Do not "fix" it by pasting in a browser user-agent — that is what
breaks it.

---

## Swapping the algorithm

The repo is split so the algorithm and the draft-room plumbing can change
independently:

| File | Owns |
| --- | --- |
| `strategy.js` | The algorithm. Valuation, opponent projection, queue planning. Touches no DOM and reads no globals — it receives a snapshot and returns decisions. |
| `queue-manager.user.js` | Everything Yahoo. Reading the board, clicking, dragging, tab state, timing, the overlay. |

To run your own logic, define `window.YS_STRATEGY` before the assistant loads and
implement four methods — `baselines`, `project`, `rank` and `plan`. The interface
and the full shape of the snapshot are documented at the top of `strategy.js`. The
manager validates the shape at load and refuses a partial strategy, rather than
discovering a missing method halfway through a draft.

```bash
node strategy-smoke.js   # runs the algorithm with no DOM and checks its output
```

That harness traps `document` and `window`, so it fails immediately if the
algorithm ever reaches into the draft room.

## Configuration

Nothing needs setting. To change a default, set `window.YS_CONFIG` before clicking
the bookmarklet — it overrides the `CFG` block in `queue-manager.user.js`:

```js
window.YS_CONFIG = {
  QUEUE_SIZE: 10,           // players to keep queued
  AUTOPICK_AT_SECONDS: 2,   // draft the queue top at 2s left; 0 disables
  DRY_RUN: true,            // log intentions without touching the queue
};
```

Every parameter is listed in [CONFIG.md](CONFIG.md). The reasoning behind the
valuation is in [ALGORITHM.md](ALGORITHM.md), where each factor is labelled
(S1–S4, O1–O17, V1–V14, Q1–Q11) so it can be named directly. Wanted but not built:
[ENHANCEMENTS.md](ENHANCEMENTS.md).

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `FAILED: ... Failed to fetch` | `serve.py` isn't running, or it's on another port. |
| `no strategy loaded` | `strategy.js` didn't load. The loader fetches it before the manager; check the server is serving the whole directory. |
| A permission dialog appears on load | Chrome asking to reach localhost. Click **Allow** — expected the first time. To avoid it entirely, host the files on any public HTTPS origin and set `window.YS_BASE` to that URL. |
| The console refuses to paste | Chrome requires you to type `allow pasting` into the console once, then paste again. The bookmark avoids this. |
| The `javascript:` line becomes a web search | You pasted it into the address bar, which strips the prefix. It only works as a bookmark's URL. |
| The fetch hangs forever with no error | The browser is blocking the request to localhost rather than refusing it, usually a privacy/shield setting on the Yahoo tab — allow localhost for that site. Check the server itself with `curl http://localhost:8765/strategy.js` from a terminal; if that works, it is the browser, not `serve.py`. |
| `no team context — playoff modifier will be 1.0` | `team-context.gen.js` wasn't served. Harmless; the playoff factor just goes flat. |
| Nothing queues | You set `DRY_RUN: true`. The `armed —` log line says which mode it is in. |
| Queue stays empty on your first turn | It was loaded too late — it will not edit the queue during your own clock. |
| Wrong slot in the log | It corrects itself from the URL and logs `slot detected as N`. |

Stop it at any time with `window.__queueStop()`. Inspect live state with
`window.__queueDump()` and the running log with `window.__queueLog`.

---

## License

MIT
