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
- **A Chromium browser** (Chrome, Edge, Brave) — the loader uses a bookmarklet or
  the DevTools console.
- **Node 18+** — *optional*, only to refresh the ESPN team data. A generated copy
  ships in the repo, so you can skip this.

No browser extension. No npm install. No API keys.

---

## Install

```bash
git clone https://github.com/jdfree/yahoo-football-draft-assistant.git
cd yahoo-football-draft-assistant
python3 serve.py
```

That prints the bookmarklet you'll use:

```
serving /path/to/yahoo-football-draft-assistant on http://localhost:8765
bookmarklet:
javascript:(function(){var s=document.createElement('script');s.src='http://localhost:8765/bootstrap.js';document.body.appendChild(s);})()
```

Leave it running. Save that line as a bookmark — name it anything, paste the whole
`javascript:...` string as the URL.

Pass a different port as an argument if 8765 is taken: `python3 serve.py 9000`.

---

## Run it against a draft

1. **Join your draft** and wait for the room to open. The URL will look like
   `.../draftclient/f1/10429766/14` — the last number is your draft slot.
2. **Once the board is visible**, click the bookmarklet.
   No bookmarklet? Open DevTools (F12) → Console, and paste:
   ```js
   var s=document.createElement('script');s.src='http://localhost:8765/bootstrap.js';document.body.appendChild(s);
   ```
3. **Check the console.** You want these lines:
   ```
   [assistant loader] team context loaded
   [assistant loader] loaded — DRY RUN; slot and league size are detected from the room
   armed — DRY RUN, target 10, slot 14
   ```
4. **Go live.** It starts in dry run, which logs what it *would* queue and touches
   nothing. When the log reads sensibly, run this in the console and click the
   bookmarklet again:
   ```js
   window.YS_CONFIG = { DRY_RUN: false };
   ```

**Your slot and league size are detected, not configured.** The slot comes from
the URL and the team count is counted off the draft-order strip; both override
anything in the config. There is nothing to fill in.

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

## Configuration

Nothing needs setting. To change a default, set `window.YS_CONFIG` before clicking
the bookmarklet — it overrides the `CFG` block in `queue-manager.user.js`:

```js
window.YS_CONFIG = {
  DRY_RUN: false,
  QUEUE_SIZE: 10,           // players to keep queued
  AUTOPICK_AT_SECONDS: 2,   // draft the queue top at 2s left; 0 disables
};
```

Every parameter is listed in [CONFIG.md](CONFIG.md). The reasoning behind the
valuation is in [ALGORITHM.md](ALGORITHM.md), where each factor is labelled
(S1–S4, O1–O17, V1–V14, Q1–Q11) so it can be named directly.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `FAILED: ... Failed to fetch` | `serve.py` isn't running, or it's on another port. |
| Chrome asks for local-network permission | Expected on first load; allow it. To avoid it entirely, host the files on any public HTTPS origin and set `window.YS_BASE` to that URL. |
| `no team context — playoff modifier will be 1.0` | `team-context.gen.js` wasn't served. Harmless; the playoff factor just goes flat. |
| Nothing queues | Still in `DRY_RUN`. The log says which mode it's in. |
| Queue stays empty on your first turn | It was loaded too late — it will not edit the queue during your own clock. |
| Wrong slot in the log | It corrects itself from the URL and logs `slot detected as N`. |

Stop it at any time with `window.__queueStop()`. Inspect live state with
`window.__queueDump()` and the running log with `window.__queueLog`.

---

## License

MIT
