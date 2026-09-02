# Configuration

Every knob, what it does, and when to change it. Nothing here needs setting to run
a draft — see [README.md](README.md) for that. The reasoning behind these values
is in [ALGORITHM.md](ALGORITHM.md), where each factor carries a label (`V6`, `O15`)
referenced in the last column.

Override anything by setting `window.YS_CONFIG` before loading the assistant; it
is merged over the `CFG` block in `queue-manager.user.js`.

```js
window.YS_CONFIG = { DRY_RUN: false, QUEUE_SIZE: 12 };
```

---

## Detected, not configured

| Key | Default | Notes |
| --- | --- | --- |
| `SLOT` | 1 | Read from the draft-room URL (`.../draftclient/f1/<room>/<slot>`). Detection overrides config and logs `slot detected as N`. |
| `TEAMS` | 12 | Counted off the draft-order strip, which mirrors at the turn. Falls back to narrowing from `ROUND r, PICK n` headers, which resolves at the first pick of round 2. |

Set them only if you are running somewhere the room does not expose them.

---

## Safety

| Key | Default | What it does |
| --- | --- | --- |
| `DRY_RUN` | `true` | Logs every intention and touches nothing. The loader forces this on, so going live is deliberate: `window.YS_CONFIG = { DRY_RUN: false }`. |
| `AUTOPICK_AT_SECONDS` | `0` | Draft the top of the queue with this many seconds left. `0` disables it — Yahoo already drafts your queue top when the clock expires, so this only matters if you want it to happen a moment early. |
| `PAIR_SPLIT_AT_SECONDS` | `1` | On the second of two back-to-back picks, draft the top queued player at a **different** position from the one just taken (`Q10`). This is the only guard against a turn spending both picks on one position. |
| `TICK_MS` | `2000` | How often the main loop runs. |

---

## League shape

| Key | Default | What it does |
| --- | --- | --- |
| `STARTERS` | `QB1 RB2 WR2 TE1 K1 DEF1` | Starting slots. Drives roles, baselines and the must-fill override (`S4`, `V1`, `V11`). |
| `FLEX` | `1` | W/R/T slots. |
| `CAPS` | `QB2 RB6 WR7 TE3 K1 DEF1` | Most you will ever roster at a position. Applies to us (`V12`) and to simulated opponents (`O13`). |
| `POOL` | six position names | The player-table filters swept at startup (`S1`). |

Change `STARTERS` and `FLEX` to match your league. Both feed the baselines, which
are computed once and never recomputed, so they must be right before the draft
starts.

---

## Queue

| Key | Default | What it does |
| --- | --- | --- |
| `QUEUE_SIZE` | `10` | Players to keep queued. Also sets the rebuild window (`QUEUE_SIZE / 2` picks before your turn, `Q1`) and the per-position caps (`QUEUE_SIZE / 2` skill, `QUEUE_SIZE / 4` for K and DEF, `Q6`). Below 8 the K/DEF cap floors to 1 and you lose the fallback kicker. |
| `ENFORCE_QUEUE_ORDER` | `true` | Keep the queue in rank order by **dragging** rows (`Q5`). Off leaves new entries wherever Yahoo appends them. |
| `VETO_AFTER` | `3` | Pull the same player out of the queue this many times and he is never queued again (`Q7`). |
| `LATE_ONLY` | `[]` | Positions held back to the last two rounds. Empty by design: kickers and defenses are measured against the end of the draft, so the arithmetic already sinks them. |

---

## Valuation weights

| Key | Default | What it does |
| --- | --- | --- |
| `WEIGHT_STARTER` | `1.0` | A player filling an empty starting slot (`V5a`). |
| `WEIGHT_FLEX` | `0.9` | Filling a flex slot (`V5b`). |
| `WEIGHT_RESERVE` | `0.2` | Bench only (`V5c`). At 0.2 a bench player must be worth five times a starter's surplus to outrank him — enough to keep a mediocre backup behind a real starting need, while still letting a genuinely large gap win. |
| `BENCH_RB_WR_MULTIPLIER` | `2` | A reserve RB or WR counts this many times a reserve elsewhere, so an effective `0.4` (`V6`). Depth matters more there: two start plus a flex, and they miss time most often. **Ours only** — the opponent model carries the same idea in its reserve baselines instead. |

No position is worth more than another *as a starter*. Positional preference
exists only among reserves.

---

## Opponent model

| Key | Default | What it does |
| --- | --- | --- |
| `PROJECT_AT_PICKS_AWAY` | `3` | Run the projection when this close to your turn (`O1`). Running it late is the point — it then reflects the picks that just happened. |
| `SIM_ROSTER_LIMITS` | `QB2 TE1 K1 DEF1` | How many of a position a simulated team will ever carry (`O15`). Raise `QB` above 2 only for superflex or 2QB leagues. |
| `SIM_KDEF_LAST_ROUNDS` | `2` | Opponents consider a kicker or defense only in their last this-many roster spots (`O16`). |
| `SIM_JITTER` | `0.15` | Per-team positional offset, scaled to the gap between that position's starter and reserve bars (`O17`). Without it every simulated team evaluates identically and the model forecasts synchronised runs. `0` restores deterministic behaviour. |

---

## Tie-breakers

| Key | Default | What it does |
| --- | --- | --- |
| `BYE_FACTOR` | `0.5` | Penalty for stacking players at one position on the same bye week (`V8`). `0` ignores byes. |
| `SAME_TEAM_PENALTY` | `0` | Compounding `(1 − p)^teammates` penalty on the projection, exempt for K and DEF (`V7`). Off by default. |
| `PLAYOFF_WEEKS` | `[15, 16, 17]` | Your league's fantasy playoff weeks. Must match what `fetch-team-context.js --playoffs` was run with. |
| `PLAYOFF_SWING` | `0.10` | Total spread between the easiest and hardest playoff schedule (`V9`). At `0.10` two otherwise identical players differ by 10%. `0` ignores schedule. Shown beside the value as its own figure, never folded into it. |

---

## Display

| Key | Default | What it does |
| --- | --- | --- |
| `SHOW_FLOORS` | `true` | The floors strip across the bottom of the window: the horizon and the projected floor at each position, plus the FLEX floor (`Q9`). Red means the projection has been overtaken by the live board. |
| `ANNOTATE_QUEUE` | `true` | Print each queued player's surplus under his name, with the playoff-schedule delta beside it. The figure carries **no** modifiers — not role weight, bye, teammate, bench multiplier or schedule — those shape order only. |

---

## Inspecting a running draft

| Call | Returns |
| --- | --- |
| `window.__queueDump()` | Config, roster, queue and current plan. |
| `window.__queueLog` | The running log. |
| `window.__floorScore()` | Projection accuracy per horizon: predicted vs actual floors and positional mix. |
| `window.__queueState` | Raw internal state — pool, taken set, floors, picks. |
| `window.__queueStop()` | Stops the assistant. |
