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
| **S4** | Baselines — two sets | **Starter bar:** the Nth-best at that position where `N = TEAMS × starting slots`. No flex factor. **Reserve bar:** how deep a team plausibly goes for a backup — K and DEF get *no* reserve, so the same bar as the starter; QB and TE assume one; RB and WR assume one reserve **per starter**, since that is where depth is carried. At 14 teams: QB 14th/28th, RB 28th/56th, WR 28th/56th, TE 14th/28th, K and DEF 14th/14th. Computed once, never recomputed, and used **only** by the opponent model. |

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
| **O5** | *(retired)* | Teams no longer restrict themselves to positions with an open starting slot. O15 does the work more directly. | — |
| **O6** | *(retired)* | No explicit late gate for kickers and defenses. Against the static baseline their surplus is small and O15 caps them at one, so they fall to the late rounds on their own. | — |
| **O7** | *(retired)* | No bench mode. With O5 gone there is no starter/bench distinction to fall back from. | — |
| **O8** | Bye limit | A team will not take a third player at one position sharing a bye week. | — |
| **O9** | Score | `score = (projection − bar) × weight`, where the **bar** is the starter bar if this pick would fill an open starting slot at that position and the reserve bar otherwise, and the **weight** is `WEIGHT_STARTER` or `WEIGHT_RESERVE` accordingly. There are no positional multipliers of any kind: the whole difference between positions lives in how deep their two bars sit. | `S4`, `WEIGHT_*` |
| **O10** | *(retired)* | No RB/WR multiplier in the opponent model. The reserve bar at `TEAMS × 4` for RB and WR carries the same idea structurally, and stacking a multiplier on top double-counted it. `BENCH_RB_WR_MULTIPLIER` still governs **V6** on our side. | — |
| **O11** | *(retired)* | There is no floor on the score. Clamping negatives to `+1` made every candidate below the bar exactly equal, so O12 stopped breaking ties and made the entire decision — 24 of 30 late picks went to running back, and with the rolling bar of O9 whole rounds went to a single position. A pick still happens: the best of several negative scores is still the best. | — |
| **O12** | Tie-break | Ties go to running back. | — |
| **O13** | Roster caps | A team will not exceed `CAPS[pos]` at any position. | `CAPS` |
| **O16** | K/DEF timing | Opponents consider a kicker or defense only in the last `SIM_KDEF_LAST_ROUNDS` rounds — anchored to the final two picks of a roster. Behavioural, and deliberately overriding the arithmetic. | `SIM_KDEF_LAST_ROUNDS: 2` |
| **O17** | Per-team jitter | Each simulated team draws a fixed positional offset for the run, scaled to the gap between that position's starter and reserve bars — so the jitter means the same at QB, where the gap is 71 points, as at DEF, where it is 14. Without it every team evaluates identically, so a position that tips becomes best for all of them at once and the model forecasts synchronised runs: 14 quarterbacks across a 42-pick window against 2 actually drafted, and earlier 17 tight ends and 24 running backs. Fixed for the run rather than per pick, because a manager who reaches for tight ends does so consistently. `0` restores deterministic behaviour. | `SIM_JITTER: 0.15` |
| **O15** | Roster limits | How many of a position one team will ever carry: QB 2, **TE 1**, K 1, DEF 1. RB and WR are left to `CAPS`. TE is one because drafters eschew a second tight end rather than roster a replacement-level one — the arithmetic disagrees, since a 120-point tight end against a reserve bar of 84.56 scores +35, and the model duly predicted 17 tight ends in 30 picks. A roster already over a limit through real picks simply takes nothing more there. QB stays at 2. It was briefly cut to 1 after the model forecast 14 quarterbacks — the whole league — inside a 44-pick window in round 9, which looked absurd. It wasn't: in a 14-team league the flex pool is picked thin by that point, and a second quarterback really is the rational pick. The forecast was right and the intuition was wrong. Raise QB above 2 only for superflex or 2QB. | `SIM_ROSTER_LIMITS` |
| **O14** | Output | Per position, a ladder of up to **12** surviving players in projection order. The head of each ladder is that position's **floor**. Every horizon computed is retained, keyed by target pick. | — |

**Where this landed.** The model now produces a plausible draft shape: RB/WR through
the early rounds, TE and QB from round 6, K and DEF from round 8 — with no explicit
gate forcing any of it. A simulated roster reads
`RB, RB, WR, RB, WR, TE, RB, DEF, K, QB, WR, WR`. **Unconfirmed on a live board.**

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
| reserve, RB/WR/TE | **V14** — the **flex floor**: the highest floor across RB, WR and TE at the deepest horizon. All three end up competing for the same flex spot, so the alternative to taking one is not "another back" but "the best of the three" |
| reserve, other | the floor at his own position, from the deepest horizon projected |

**V14 in practice.** Measuring each bench player against his own position's floor
let a back with a collapsed RB floor (101.1) show +37.5, and at `0.2 × 2 = 0.4`
that was enough to outrank a receiver filling an open *starting* slot whose raw
points were higher. Against the flex floor of 135.0 the same back is worth +3.6,
and the receiver is unchanged at 12.00. Starting slots keep their own position's
floor — a WR slot can only be filled by a receiver.

**V13 — the floor is clamped to the board.** A floor claims "this good a player
will still be there later", and the pool only shrinks, so the claim is refuted the
moment the board falls below it. The bar is therefore `min(floor, best available
now)`. Live: a projection made at pick 74 promised a 173.46 receiver at pick 126
while the best on the board at pick 111 was already 139.09 — and at slot 14, where
turns are 27 picks apart, that stale floor stood for fifty picks. The strip shows
the clamped figure, in red when the projection has been overtaken.

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
| **Q5** | Reorder by drag | Order is corrected by **dragging**, never by removing and re-adding. Queue rows carry dnd-kit handles with a documented keyboard protocol (space to lift, arrows to move, space to drop). Selection sort: at most one move per slot, and no player who belongs in the queue is ever removed from it. `reconcileQueue` violated this for a long time: under `ENFORCE_QUEUE_ORDER` a rebuild found the longest correctly-ordered prefix and doomed **everything after it**, including players the plan still wanted. Those players were not re-added in the same cycle — the add pass works off `missing`, and they were present when the delta was computed — so they vanished for a cycle or more. Live: the best quarterback on the board was queued, evicted for sitting one seat too low, and was still missing when our turn came. An entry is now dropped for one reason only — the plan no longer wants him. | `ENFORCE_QUEUE_ORDER: true` |
| **Q6** | Position limits | No position may occupy more than `QUEUE_SIZE − 2` queue slots, so a run on one position cannot leave the whole queue useless. K and DEF are capped at **2** — a pick and a fallback. There is only ever one kicker worth having, so a cap of 1 leaves nothing behind him if he is sniped between the rebuild and our clock. The cap used to collapse to 1 on back-to-back picks, to stop a turn spending both on kickers; **Q10** already prevents that at the draft click, by position, so the clause only stripped the fallback out of every turn-slot queue. Round 13 at a turn slot: top kicker queued, no kicker behind him, every remaining entry at negative surplus. | — |
| **Q7** | Veto | Pull the same player out of the queue N times and he is never queued again. Detected in two passes: a disappearance is only *suspected*, then counted on the next pass once the picks feed has caught up and he is still undrafted — otherwise a player drafted a moment earlier is blamed on the human. | `VETO_AFTER: 3` |
| **Q9** | Floors strip | A bar across the bottom of the window showing the horizon and the floor at each position — the numbers every valuation rests on. Shows each position's floor plus the **FLEX** floor — the highest of RB/WR/TE, which is the bar every flex-eligible backup is measured against (V14). Reports the floors **currently in use** (the latest projection), not the nearest horizon ahead; those differ, and a strip reporting a horizon nothing uses is worse than none. | `SHOW_FLOORS: true` |
| **Q10** | Back-to-back split | On the **second** of two consecutive picks, with `PAIR_SPLIT_AT_SECONDS` left on the clock, draft the top queued player at a **different position** from the one just taken. Yahoo drafts the queue top when a clock expires, and that top rarely moves in the seconds between two consecutive picks, so a turn can spend both on the same position. Fires whether or not `AUTOPICK_AT_SECONDS` is enabled, and only with the clock nearly gone, so your own pick always takes precedence. "Second of a pair" is detected from the **roster**: it is snapshotted when the turn begins, and a position that has grown while the turn is still running is the one just taken. Reading the picks feed instead failed outright — across back-to-back picks Yahoo keeps "your turn" continuous and the header lags, so at the second pick it still reported the first pick's number, and the tick does not sync the picks feed during our own turn anyway. Live, both picks went RB and the rule never fired. | `PAIR_SPLIT_AT_SECONDS: 1` |
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
| `BENCH_RB_WR_MULTIPLIER` | 2 | V6 (ours only) |
| `SIM_ROSTER_LIMITS` | QB2 TE1 K1 DEF1 | O15 |
| `SIM_KDEF_LAST_ROUNDS` | 2 | O16 |
| `SIM_JITTER` | 0.15 | O17 |
| `PROJECT_AT_PICKS_AWAY` | 3 | O1 |
| `SAME_TEAM_PENALTY` | 0 | V7 |
| `BYE_FACTOR` | 0.5 | V8 |
| `PLAYOFF_WEEKS` | 15, 16, 17 | V9 |
| `PLAYOFF_SWING` | 0.10 | V9 |
| `ENFORCE_QUEUE_ORDER` | true | Q5 |
| `SHOW_FLOORS` | true | Q9 |
| `VETO_AFTER` | 3 | Q7 |
| `PAIR_SPLIT_AT_SECONDS` | 1 | Q10 |
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

## Testing caveat

Mock drafts run under **standard scoring** with Yahoo autodrafters that largely
follow ADP. Their behaviour is therefore not ground truth: matching it would train
the model toward ADP and away from the projected-points reasoning that matters
under custom scoring with human drafters. Where the model and the mock disagree —
QB being the clearest case — the model may well be right. Mixes are worth reading
for *synchronisation* artefacts, which are real defects, rather than for
positional agreement with ADP.

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
- **Rounds 1–3 are still entirely RB/WR in simulation.** Dropping O10 moved QB a
  round earlier and TE two, but the opening rounds remain 100% backs and
  receivers, where reality is closer to 90% with the occasional elite tight end.
  The deepened RB baseline may be too aggressive.
- **Where, not whether.** The two samples above disagree on QB and TE (+23.8 then
  +6.2; +17.9 then +6.7) and are confounded by measurement lag. Only WR looks
  consistent so far, at about −8 both times. Several drafts of clean at-target
  scoring are needed before any of it means anything.
- **Floors are lost on reload.** `state.floors` is in memory, so the deepest
  horizon that V2 reads for reserves resets when the script reloads.
