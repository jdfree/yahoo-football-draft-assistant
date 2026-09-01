# yahoo-football-draft-assistant

A fantasy football draft assistant. Works for mock drafts and real drafts.

It builds its picture from two places: NFL team strength and schedule from ESPN,
gathered before the draft, and the live player pool read out of the draft room the
moment it opens. Both feed a single valuation that prices positional scarcity
without needing to be told the league's scoring rules.

To automate a Yahoo draft room end to end instead, see
[yahoo-football-autodraft](https://github.com/jdfree/yahoo-football-autodraft).

## Team context

```bash
node fetch-team-context.js                 # writes team-context.json
node fetch-team-context.js --playoffs 14,15,16
```

Node 18+, no dependencies. Reads:

- [ESPN FPI](https://www.espn.com/nfl/fpi) — Football Power Index, offensive /
  defensive / special-teams EPA
- [ESPN schedule grid](https://www.espn.com/nfl/schedulegrid) — all 18 weeks

and writes per team: FPI and rank, EPA splits, bye week, the full schedule,
season strength of schedule, and **fantasy-playoff schedule difficulty** with the
multiplier the queue manager applies.

Playoff difficulty is `opponent defensive EPA − opponent offensive EPA`, averaged
over your playoff weeks. A strong opposing defense hurts; a strong opposing
*offense* helps, because it forces a competitive, high-possession game. So facing
a good all-round team can grade as an easy fantasy matchup — that is the metric
working, not a bug.

```
  # Team   FPI  Bye  Diffcty  Modifier  Opponents
  -- easiest --
  1 CHI    1.2   10  -3.167    1.0500   @BUF GB DET
  2 MIA   -5.8    6      -2    1.0280   @GB LAC BUF
  -- hardest --
 31 LV    -4.6   13     1.6    0.9601   DEN TEN @ARI
 32 ARI   -5.2   14   2.133    0.9500   NYJ @NO LV
```

It also emits `team-context.gen.js`, a compact `window.YS_TEAM_CONTEXT` for the
userscript to read — the browser cannot open a local JSON file, so paste that
alongside the userscript in Tampermonkey.

This is static preseason data with no dependency on a draft room, so run it
whenever — ideally the morning of, since FPI moves through the preseason.

**It validates itself.** 272 games, exactly one bye per team, and every matchup
reciprocated with opposite home/away. A silent mis-parse is the real risk with
scraped data, so the script fails loudly instead of emitting a half-built table.

One quirk worth knowing: ESPN serves a JavaScript bot-challenge page to clients
claiming to be Chrome, and the real HTML to anything that identifies honestly as a
script. The script therefore sends its own user-agent. Do not "fix" it by pasting
in a browser user-agent — that is what breaks it.

## Running it — no extension required

The Yahoo draft room sends **no Content-Security-Policy**, so the page can fetch and
evaluate the assistant from anywhere. There is no userscript manager to install.

```bash
python3 serve.py          # serves this directory on http://localhost:8765
```

Then, from the draft room, run the bookmarklet `serve.py` prints:

```
javascript:(function(){var s=document.createElement('script');
s.src='http://localhost:8765/bootstrap.js';document.body.appendChild(s);})()
```

`bootstrap.js` loads the playoff modifiers and the assistant, and sets
`window.YS_CONFIG` — so nothing in the repo needs editing to change your slot,
queue size, or whether it runs live:

```js
window.YS_CONFIG = { SLOT: 4, TEAMS: 12, DRY_RUN: false, AUTOPICK_AT_SECONDS: 2 };
```

**One caveat with localhost:** Chrome asks for local-network permission the first
time the page fetches it, and blocks until you answer. Serving the two files from
any public HTTPS origin instead avoids the prompt entirely — set
`window.YS_BASE` to point at it.

## How it decides

[ALGORITHM.md](ALGORITHM.md) is the full reference for both valuations — ours and
the opponent model — with every factor labelled (S1–S4, O1–O14, V1–V12, Q1–Q8) so
they can be named directly when tuning.

## Queue manager

`queue-manager.user.js` (Tampermonkey) keeps the five best available players in
your Yahoo queue. **It never drafts.** When your turn arrives it goes silent and
hands the draft back to you — the queue is the safety net, because Yahoo drafts
the top of your queue if your clock expires.

Set `CFG.SLOT` and `CFG.TEAMS`, leave `DRY_RUN: true` for a full mock, then go live.
All parameters — queue size, starter/reserve weighting, playoff weeks and bias, and
the bye-week factor — are documented in [CONFIG.md](CONFIG.md).

How it works:

- **Reads the player pool once**, at draft start — top 75 QB and TE, top 300
  WR/RB/Flex, all kickers and defenses, with NFL team, projected points, ADP and
  bye. None of that changes during a draft, so there is no reason to read it twice.
- **Tracks availability from the picks feed**, not by rescanning the player table.
  Each pick just removes a name from the pool.
- **Refills whenever the queue drops below five**, which happens exactly when one
  of your queued players is drafted by anyone.
- **Does nothing during your turn.** No clicks, no queue edits, no tab switching.

Every player row carries `.ys-addqueue[data-id]` — Yahoo's own player id, and the
only stable key in the room. Names are abbreviated to a first initial and collide
(`B. Robinson` is two different running backs), so nothing keys on them.

## How it values a player

```
raw   = projected points − the bar for the slot he would fill
value = raw × 1.0   fills an empty starting slot
        raw × 0.9   fills flex
        raw × 0.2   bench only
```

**The bar depends on the slot, not the position.** For a dedicated slot it is the
best player at that position still expected at your next turn. For *flex* it is
the best RB, WR or TE — because if you pass on a tight end for flex, your
alternative is not another tight end. Using the position's own bar there credits a
TE for tight-end scarcity already spent on the dedicated TE slot: live, with RB
and TE both full, it ranked T. Warren (TE, 162.4 proj) above D. Montgomery (RB,
185.2 proj) for the same flex slot.

**Ranking is by value, with role expressed as a weight rather than a hard rule.**
At `WEIGHT_RESERVE` 0.2 a bench player must be worth five times a starter's
surplus to pass him. That keeps a mediocre backup below a real starting need,
while still letting a genuinely large gap win: a running back worth +80 on the
bench outranks a defense worth +3.3 filling the last starting slot, which is the
trade any sensible drafter makes. Tiering starters strictly above bench players
got that backwards.

Attrition before your next turn comes from the projection (see
[PROJECTION.md](PROJECTION.md)), with an ADP survival model as fallback. The result
handles unusual scoring on its own: a position where every startable player
projects about the same is correctly valued near zero, however large the raw
numbers look.

## License

MIT
