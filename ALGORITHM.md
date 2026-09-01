# Algorithm reference

Every factor is labelled so it can be named directly — "raise **O10**", "**V6** is
too strong". Labels are stable; if a factor is removed its label is retired
rather than reused.

There are two valuations, and they are not the same.

**We** value a player by what we gain by taking him now instead of waiting. Our
bar is the projected floor.

**Opponents** are modelled by value over a replacement-level player — but that bar
is no longer frozen. Only the *first* projection of a draft measures against the
static worst-starter baseline (S4); every projection after it measures against the
floors the previous projection produced, so the bar descends with the board.

The output therefore feeds two places: the floors become **our** bar, and they
become the **next projection's** bar. S4 survives only to seed the first run.

---

## A. Setup — once per draft

| # | Factor | What it does |
| --- | --- | --- |
| **S1** | Pool read | Six position sweeps of the player table, top 100 each. Captures Yahoo id, name, position, NFL team, projected points, ADP, bye. Projections are already scored under this league's rules, so scoring settings never have to be known. Read once — none of it changes during a draft. |
| **S2** | Drafted read | Yahoo's `Drafted` pill widens the table to include players already taken. Swept the same way and merged into the pool **by id**, so arming mid-draft still sees the whole league. Names collide (two `J. Daniels` at QB, two `B. Robinson` at RB), so id is the only safe key. |
| **S3** | League shape | Slot comes from the draft-room URL. Team count is *counted*, from the draft-order strip: a snake mirrors at the turn (`… Hugh, Ira, Ira, Hugh …`) and the mirror position is the team count. Verified by checking the first `2T` entries read the same in both directions. Fallback, if the strip is absent: every `ROUND r, PICK n` constrains `T` via `(r−1)·T < n ≤ r·T`, which resolves at the first pick of round 2. |
| **S4** | Baseline | The **worst starting-calibre projection at each position**. Computed once and never recomputed. Sort every player (S1 + S2) by projection; fill `STARTERS[pos] × TEAMS` dedicated slots top-down; then fill `FLEX × TEAMS` from the best remaining RB/WR/TE; `baseline[pos]` is the lowest projection assigned to that position. **Used only by the opponent model (O9).** It no longer sets our bar. |

S4 is frozen because it describes the league's shape, not the current board.
Recomputing it against a depleting pool walks it downward — RB fell 108.4 → 92.6
in one live draft purely because thirty-five players had been drafted in between.

---

## B. Opponent projection — what disappears before our next-but-two pick

| # | Factor | Rule | Config |
| --- | --- | --- | --- |
| **O1** | When it runs | Once per turn, when we are within N picks of being on the clock. Running it late is the point: it then reflects the picks that just happened, so a run on a position is priced in rather than averaged away. | `PROJECT_AT_PICKS_AWAY: 3` |
| **O2** | Horizon | Our **third-from-next** pick, clamped to the final pick of the draft. Simulates every pick from now to that target. | — |
| **O3** | Our own picks | Skipped, not simulated. We are predicting what is available *to us*, not boxing ourselves out. | — |
| **O4** | Opponent rosters | Taken from the live Picks feed, which names the drafter for every pick. Real rosters, not assumptions. The simulation forks a copy; `state.teamRosters` only ever changes when a real pick is observed. | — |
| **O5** | Open starting slots | A team considers only positions where it has an unfilled **dedicated** starting slot. | `STARTERS` |
| **O6** | K/DEF late gate | Kickers and defenses are excluded until the last N rounds. A kicker scores positive against baseline from round one, so without this the model drafts them constantly — 11 kickers and 11 defenses in 29 picks, observed. | `OPPONENT_LATE_K_DEF: 2` |
| **O7** | Bench fallback | If O5 minus O6 leaves nothing — the usual mid-draft case, where a team's only gaps are K and DEF — the team considers **all** positions and takes bench depth. Without this those teams drafted nobody: a 38-pick horizon simulated 2 picks. | — |
| **O8** | Bye limit | A team will not take a third player at one position sharing a bye week. | — |
| **O9** | Score | `score = projection × O10 − bar[position]`, where the **bar rolls forward**: the first projection of a draft uses the static baseline S4, and every projection after it uses the floors from the most recent *completed* projection. The bar therefore tracks the board instead of staying pinned to preseason. Resolved once before any pick is simulated and passed down, and this run's floors are not stored until it returns — so a projection can never read itself. | `S4` seeds it |
| **O10** | Bench RB/WR multiplier | In bench mode (O7), an RB's or WR's **score** is multiplied — the same mechanism and the same knob as V6, so the two models cannot drift apart and one fix serves both. Scaling a surplus inverts once it goes negative; with the rolling bar (O9) that is the wanted behaviour rather than a defect, since a negative score means the position is picked over and doubling it pushes RB and WR further down. | `BENCH_RB_WR_MULTIPLIER: 2` (shared with V6) |
| **O11** | *(retired)* | There is no floor on the score. Clamping negatives to `+1` made every candidate below the bar exactly equal, so O12 stopped breaking ties and made the entire decision — 24 of 30 late picks went to running back, and with the rolling bar of O9 whole rounds went to a single position. A pick still happens: the best of several negative scores is still the best. | — |
| **O12** | Tie-break | Ties go to running back. | — |
| **O13** | Roster caps | A team will not exceed `CAPS[pos]` at any position. | `CAPS` |
| **O14** | Output | Per position, a ladder of up to **12** surviving players in projection order. The head of each ladder is that position's **floor**. Every horizon computed is retained, keyed by target pick. | — |

**The late-round skew, and its cause.** A live round-7 projection took 23 running
backs out of 32 picks. The cause was O11 and O12 together: once every remaining
player sat below a fixed baseline, every score clamped to `+1`, and the running-back
tie-break decided every pick. O10 was ruled out — it applies to RB and WR alike.
Both halves are now addressed: the bar rolls forward (O9) so it stays near the
board, and the clamp is gone (O11).

---

## C. Our valuation — every candidate, every ranking

### C.1 Role (V1)

| Condition | Role | Weight |
| --- | --- | --- |
| `count(pos) < STARTERS[pos]` | starter | **V5a** `WEIGHT_STARTER: 1.0` |
| position is RB/WR/TE and a flex slot is open | flex | **V5b** `WEIGHT_FLEX: 0.9` |
| otherwise | reserve | **V5c** `WEIGHT_RESERVE: 0.2` |

No position is worth more than another *as a starter*. Positional preference
exists only among reserves (V6).

### C.2 The bar (V2)

| Role | Bar |
| --- | --- |
| starter | the floor at his own position — the best player expected to survive to O2 |
| flex | the **highest** floor across RB/WR/TE — a flex slot is contested by all three, so passing on a tight end leaves you the best flex-eligible player, not another tight end |
| reserve | the floor from the **deepest** horizon projected — a bench player competes for a late pick, not this one |

**V3 — self-exclusion.** A player is never his own replacement; the ladder (O14)
is searched skipping his own id. Without it the best player at a position scored
zero surplus and the model concluded that passing on him would leave him there.

The worst-starter baseline (S4) is **not** part of the bar. Surplus over the floor
means "what I gain by taking him now instead of waiting"; surplus over the
baseline means "how much better than a replacement starter". Taking the greater of
the two switched between those quantities silently.

### C.3 Displayed value (V4)

```
V4  raw = projection − bar
```

This is the number shown in the queue, and it carries **no modifiers at all** —
not role weight, not bye, not teammate, not bench multiplier, not playoff
schedule. Everything below shapes the queue's *order* only.

**Negative values are meaningful and expected.** Only the best available player at
a position clears his own bar; anyone projecting below the floor reads negative,
which correctly says the board will still offer someone better later.

### C.4 Ordering (V10)

```
V10  sortVal = (projection × V7 − bar) × V5 × V6 × V8 × V9
```

| # | Factor | Rule | Config |
| --- | --- | --- | --- |
| **V6** | Bench RB/WR multiplier | A reserve RB or WR counts this many times a reserve elsewhere. Effective weight `0.2 × 2 = 0.4`. Depth matters more at those positions — two start plus a flex, and they miss time most often — while a backup QB behind a starter is worth almost nothing however large his nominal surplus. | `BENCH_RB_WR_MULTIPLIER: 2` |
| **V7** | Same-team penalty | `(1 − p)^teammates` on the projection, compounding. Exempt for K and DEF. | `SAME_TEAM_PENALTY: 0` |
| **V8** | Bye multiplier | `1 − BYE_FACTOR × min(1, clashes / starting slots at that position)`, where a clash is a player already held at the same position on the same bye. | `BYE_FACTOR: 0.5` |
| **V9** | Playoff schedule | Per-NFL-team multiplier from ESPN FPI over the fantasy playoff weeks: `opponent defensive EPA − opponent offensive EPA`, averaged, scaled to a total swing. Shown beside the value as its own figure (`+1.1`, `−2.3`), never folded into V4. | `PLAYOFF_WEEKS: [15,16,17]`, `PLAYOFF_SWING: 0.10` |
| **V11** | Must-fill override | When unfilled required positions ≥ picks remaining, only that position is offered, sorted by raw projection, at `sortVal = Infinity`. | `STARTERS`, roster size |
| **V12** | Legality | A player is excluded outright once `CAPS[pos]` is reached on our roster. | `CAPS` |

There is **no role tier**. Ranking is on `sortVal` alone, so role acts as a
weight rather than a hard rule: a bench back worth +80 outranks a defense worth
+3.3 filling the last starting slot, while a mediocre bench back at +8 still loses
to a genuine starting need.

---

## D. Queue mechanics

| # | Factor | Rule | Config |
| --- | --- | --- | --- |
| **Q1** | Rebuild schedule | A full recompute of membership **and** order happens once per turn, `QUEUE_SIZE / 2` picks before we are on the clock — or whenever new floors land (O1), since those reprice every queued player. | `QUEUE_SIZE: 8` |
| **Q2** | Back-to-back | When our next two picks fall inside the same window there is no chance to rebuild between them, so we build once, before the first. | — |
| **Q3** | Between rebuilds | The queue is left alone entirely, apart from replacing players who have actually been drafted — one out, one in, appended. | — |
| **Q4** | Delta, add-first | A rebuild adds every missing planned player **before** removing anything, and removes only entries the plan no longer wants. A rebuild can be cut short by our clock, and adding first means an interruption leaves more good players, never fewer. The queue may briefly exceed `QUEUE_SIZE`. | — |
| **Q5** | Reorder by drag | Order is corrected by **dragging**, never by removing and re-adding. Queue rows carry dnd-kit handles with a documented keyboard protocol (space to lift, arrows to move, space to drop). Selection sort: at most one move per slot, and no player who belongs in the queue is ever removed from it. | `ENFORCE_QUEUE_ORDER: true` |
| **Q6** | Position limits | No position may occupy more than `QUEUE_SIZE − 2` queue slots, so a run on one position cannot leave the whole queue useless. K and DEF are capped at 2, or 1 when our picks are back-to-back. | — |
| **Q7** | Veto | Pull the same player out of the queue N times and he is never queued again. Detected in two passes: a disappearance is only *suspected*, then counted on the next pass once the picks feed has caught up and he is still undrafted — otherwise a player drafted a moment earlier is blamed on the human. | `VETO_AFTER: 3` |
| **Q9** | Floors strip | A bar across the bottom of the window showing the horizon and the floor at each position — the numbers every valuation rests on. Reports the floors **currently in use** (the latest projection), not the nearest horizon ahead; those differ, and a strip reporting a horizon nothing uses is worse than none. | `SHOW_FLOORS: true` |
| **Q8** | Turn safety | Nothing touches the queue while our clock is running. Every loop checks and stops. | — |

There is deliberately **no** "this entry is the human's" concept. Three attempts
to infer it from the queue all produced false marks on players the assistant had
queued itself, and the mark meant "never reorder, never remove", which froze them.
A queue read cannot distinguish "you added this" from "this was already here"
across a reload. Q7 is the one signal of intent that is reliable.

---

## E. Parameters

| Config | Default | Governs |
| --- | --- | --- |
| `QUEUE_SIZE` | 8 | Q1, Q6 |
| `STARTERS` | QB1 RB2 WR2 TE1 K1 DEF1 | S4, O5, V1, V11 |
| `FLEX` | 1 | S4, V1 |
| `CAPS` | QB2 RB6 WR7 TE3 K1 DEF1 | O13, V12 |
| `WEIGHT_STARTER` | 1.0 | V5a |
| `WEIGHT_FLEX` | 0.9 | V5b |
| `WEIGHT_RESERVE` | 0.2 | V5c |
| `BENCH_RB_WR_MULTIPLIER` | 2 | V6 **and** O10 |
| `OPPONENT_LATE_K_DEF` | 2 | O6 |
| `PROJECT_AT_PICKS_AWAY` | 3 | O1 |
| `SAME_TEAM_PENALTY` | 0 | V7 |
| `BYE_FACTOR` | 0.5 | V8 |
| `PLAYOFF_WEEKS` | 15, 16, 17 | V9 |
| `PLAYOFF_SWING` | 0.10 | V9 |
| `ENFORCE_QUEUE_ORDER` | true | Q5 |
| `SHOW_FLOORS` | true | Q9 |
| `VETO_AFTER` | 3 | Q7 |
| `LATE_ONLY` | *(empty)* | our own K/DEF gate, off — the math decides |
| `AUTOPICK_AT_SECONDS` | 0 | last-second safety pick, off |

The old queue overlay is gone; the floors strip replaced it.

There are no other knobs. `HORIZON_ROUNDS`, `SKIP_ROUNDS` and `ADP_SIGMA` are
gone, along with the ADP survival model they fed: floors are seeded before
anything is valued, so that path was unreachable. When the simulation holds no
survivors at a position — a position it never reached — the bar falls back to the
best player still available there.

---

## G. Self-scoring

Each projection is graded against what actually happened. When the draft reaches a
pick some earlier projection targeted, the best player still available at each
position is recorded and compared with what that projection predicted.

Measured **at** the target, not whenever we next look. Reading late understates
every floor, because more players have gone: one running-back error read −19.8
when measured twelve picks late, against an exact result at the horizon before it.
Each row keeps the round it was projected from, the round it landed in, and how
late it was scored, because *where* in the draft a position is mispredicted is
likely to matter more than any average bias.

`window.__floorScore()` returns the record.

Two horizons from one draft, for reference — too few to conclude anything:

| Target | Measured | QB | RB | WR | TE |
| --- | --- | ---: | ---: | ---: | ---: |
| pick 62 | 2 late | +23.8 | 0.0 | −8.0 | +17.9 |
| pick 79 | 12 late | +6.2 | −19.8 | −8.1 | +6.7 |

## F. Open questions

- **The opponent mix (O9–O12).** 23 running backs in 32 simulated picks. Every
  floor rests on this and nothing else constrains it now that S4 is out of our
  bar. Cause not yet identified — O10 is ruled out.
- **V6 / O10 with negative surplus.** The multiplier scales the surplus, so once a
  bench RB/WR goes negative it ranks him *below* an equally negative backup QB. In
  the opponent model this is now deliberate — a negative score means the position
  is picked over. On our side it is still an open question.
- **The O10 change is unmeasured.** Offline simulation cannot evaluate it: O10 is
  gated on bench mode, which depends on team rosters, and a synthetic harness has
  none. Only a live mock will show whether it moves the predicted mix.
- **Where, not whether.** The two samples above disagree on QB and TE (+23.8 then
  +6.2; +17.9 then +6.7) and are confounded by measurement lag. Only WR looks
  consistent so far, at about −8 both times. Several drafts of clean at-target
  scoring are needed before any of it means anything.
- **Floors are lost on reload.** `state.floors` is in memory, so the deepest
  horizon that V2 reads for reserves resets when the script reloads.
