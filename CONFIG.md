# Configuration

Every knob lives in the `CFG` block at the top of `queue-manager.user.js`, except
the playoff schedule data, which is precomputed by `fetch-team-context.js`.

## Quick start

```bash
# 1. Precompute team strength and playoff schedule difficulty
node fetch-team-context.js --playoffs 15,16,17 --swing 0.10

# 2. Paste team-context.gen.js into Tampermonkey ABOVE the userscript
#    (or add it as an @require). Without it the playoff modifier is 1.0.

# 3. Set CFG.SLOT and CFG.TEAMS, leave DRY_RUN true, run a mock, read the log.
```

## Displayed values carry no modifiers

The number shown for a player is the **raw surplus**: his projection minus what
you could get at that slot if you passed. Nothing else is folded in — not the
role weight, not the bye clash, not the teammate penalty, not the bench boost,
not the playoff schedule. All of those shape the queue ORDER only.

The playoff schedule is shown alongside as its own factor (`playoff ×1.028`)
rather than being blended into the headline number, so a value can always be
read one way: points above the alternative.

## `BENCH_RB_WR_BOOST` — bench depth at RB and WR

Default `0.10`. Inflates an RB's or WR's **projection** by this fraction when he
is being valued as a bench player. Bench depth is worth more at those positions:
you start two of each plus a flex, and they miss time most often.

It boosts the projection rather than multiplying the surplus, and that detail
matters. Multiplying the surplus inverts as soon as the surplus goes negative,
which is where most bench players sit by the late rounds — live, with bench
values of −0.61, −1.60 and −2.56, a ×3 multiplier pushed RB and WR *down* the
queue rather than up. A projection boost shifts the surplus upward whatever its
sign.

The same knob is used inside the opponent simulation, for the same reason. It
replaced a ×3 multiplier on surplus there, which had the identical flaw: a back
far above baseline was tripled while a receiver just below baseline floored at 1
and could never win a simulated pick, so the model drafted 28 backs and no
receivers in 31 picks.

## `LATE_ONLY` — positions held to the last two rounds

Default `[]` — nothing is held back.

Holding kickers and defenses until the end is convention, not arithmetic. The
model already prices them honestly: their replacement level is measured against
the **end of the draft** rather than the next couple of rounds, because the real
choice is "one now versus one with my last pick". That makes an early defense
have to beat every skill player on surplus before it is queued at all.

Overriding that with a hard gate costs value. In a live draft the best defense
was worth 16.74 in round 9; the gate held it to round 14, by which point the best
available was worth 6.34 — while the bench players queued in the meantime were
worth about 2.

Set to `['K', 'DEF']` to restore the conventional behaviour. Roster caps prevent
a second kicker or defense either way.

## Inspecting the preprocessing

Two artifacts, both written by scripts rather than printed:

| What | Where |
| --- | --- |
| Team strength, schedule, playoff difficulty | `team-context.json` (and `.gen.js` for the browser), written by `fetch-team-context.js` |
| Player pool, roster, rankings with every score component | run `window.__saveDump()` in the draft room |

`__saveDump()` downloads the full state as JSON — config, the whole pool, roster,
picks seen, and the top 25 with raw value, role weight, playoff modifier and bye
modifier broken out separately. `__saveDump('pool.csv')` writes just the pool as
CSV. The state is also mirrored to `localStorage.ys_dump` each tick.

The pool exists only inside the page, so exporting it to a file is the only way to
audit it properly.

---

## Draft shape

| Parameter | Default | Notes |
| --- | --- | --- |
| `TEAMS` | `12` | League size. With `SLOT`, sets the snake gap that drives replacement level. |
| `SLOT` | `1` | **Your actual draft position.** Yahoo reassigns it silently — a requested slot 3 came back as 9 and as 12 on two of four attempts. Read it off the waiting room. |
| `STARTERS` | `{QB:1,RB:2,WR:2,TE:1,K:1,DEF:1}` | Starting slots, excluding flex. |
| `FLEX` | `1` | W/R/T slots. |
| `CAPS` | `{QB:2,RB:6,WR:7,TE:3,K:1,DEF:1}` | Hard ceiling per position. |
| `POOL` | top 100 per position | Read once at draft start, replenished per position below 50 available. |
| `TICK_MS` | `2000` | How often to check the queue. Dialog dismissal is not on this timer. |

## 1. Queue size

| Parameter | Default |
| --- | --- |
| `QUEUE_SIZE` | `5` |

How many players to keep queued. The manager refills whenever the badge drops
below this, which happens exactly when one of your queued players is drafted by
anyone.

Larger is safer against a run at a position but goes further down your board, so
the tail of a long queue is worth less. Above roughly ten you are queueing players
you would not actually want.

## 2. Starters versus reserves

| Parameter | Default |
| --- | --- |
| `WEIGHT_STARTER` | `1.0` |
| `WEIGHT_FLEX` | `0.9` |
| `WEIGHT_RESERVE` | `0.2` |

A player's value is scaled by the role he would fill. What matters is the *ratio*,
not the absolute numbers.

- **Lower `WEIGHT_RESERVE`** (say `0.1`) to prioritise plugging empty starting
  slots, even with a mediocre player.
- **Raise it** (say `0.4`) to keep taking the best player available at a contested
  position and let the empty slot wait.

At the default `0.2`, a bench player must be worth five times as much over
replacement as a starter-slot filler before the manager prefers him. Setting it to
`1.0` disables role weighting entirely and drafts pure best-available.

## 3. Fantasy playoffs

| Parameter | Default | Where |
| --- | --- | --- |
| `PLAYOFF_WEEKS` | `[15,16,17]` | both |
| `PLAYOFF_SWING` | `0.10` | both |

Set the weeks your league's playoffs actually run, then regenerate:

```bash
node fetch-team-context.js --playoffs 14,15,16 --swing 0.15
```

**Difficulty metric.** For each playoff week, a player's difficulty is his
opponent's defensive EPA minus that opponent's offensive EPA:

```
difficulty = opponent.epaDefense − opponent.epaOffense      (higher = worse)
```

Both ESPN components are signed so higher is better for the team they belong to
(verified: they correlate +0.94 and +0.73 with that team's own FPI). So a strong
opposing defense raises difficulty, and a strong opposing *offense* lowers it — a
good opposing offense means a competitive, high-possession game, which is good for
your player's volume. The ideal fantasy matchup is a weak defense attached to a
strong offense.

This has a consequence worth understanding before you trust the output: facing a
strong all-round team like Buffalo can score as an *easy* fantasy matchup, because
their offense forces a shootout. That is the metric behaving as designed, not a bug.

A bye during a playoff week is scored as the worst difficulty observed anywhere in
the league — the player is simply unavailable.

**It is shown separately, not folded into the value.** The overlay renders a green
or red `SCHED` figure beside `GAIN` — the points the playoff schedule adds or
removes. `GAIN` itself stays schedule-free so two players are directly comparable,
while queue ordering uses the combined figure.

**Swing.** `PLAYOFF_SWING` is the *total* spread between the easiest and hardest
schedule in the league. At the default `0.10`, two otherwise identical players
differ by 10% — the easiest slate gets ×1.05, the hardest ×0.95, everyone else
scaled linearly between. Smaller disparities produce proportionally smaller
adjustments. Set `0` to ignore schedule entirely.

If `team-context.gen.js` was generated with a different swing than `CFG`, the
userscript rescales rather than silently using the wrong one.

## 4. Bye weeks

| Parameter | Default |
| --- | --- |
| `BYE_FACTOR` | `0.5` |

Range 0 to 1. Penalises a player whose bye week collides with players you already
hold at the same position:

```
clash      = players you hold at this position sharing this bye week
multiplier = 1 − BYE_FACTOR × min(1, clash / starting slots at that position)
```

At `0`, byes are ignored. At `1`, a player who would leave a starting slot with
nobody active that week is worth nothing. At the default `0.5`, the first
collision at a one-slot position halves his value.

## Replacement horizon

| Parameter | Default |
| --- | --- |
| `SKIP_ROUNDS` | `2` |

How many rounds to assume a position goes undrafted if you pass on it now.

Measuring against "what could I get one pick later" understates the cost of
skipping a position, because you rarely come back to it on your very next pick. At
the default of 2, replacement level is whatever would survive two full rounds of
attrition — a harsher and more realistic bar, which raises the value of players at
positions that thin out quickly.

**Attrition is predicted by ADP, and those exact players are removed.** An earlier
version counted departures by ADP and then dropped that many from the *top of the
projection list*, as though the players taken were the highest-projected. They are
not — by ADP they are the lowest-ADP ones. That inflated replacement level at any
position holding a projection/ADP outlier (a player projected 237 at ADP rank 135,
say) and made everyone at that position look less valuable than they were. Each
signal is now used for what it actually measures: ADP for *who* goes, projection
for *what they are worth*.

**A player is never his own replacement.** Replacement is computed excluding the
player being valued. Previously it was computed once per position and reused, so
the best available player at a position came out with zero surplus — the model
literally concluded "if I pass on the top receiver, the top receiver will still be
there."

**Players without an ADP are ranked by projection, not treated as immortal.** Most
of the pool carries no ADP (the column shows "–"). Storing those as 999 meant they
were never among the lowest-ADP players and so were never predicted to be drafted
at all. They now sort by projection behind everyone with a real ADP.

**ADP is treated as a mean, not a promise.** `ADP_SIGMA` (default 12 picks) sets how
much it scatters. Replacement is the *expected* best player still available —
walking the position by projection, each player contributes his projection times
the chance he is the one left: he survives and everyone better does not. A hard
cutoff instead claimed a player with ADP 130 was certain to last to pick 129, when
the top-projected player at a position is exactly who a value-drafter reaches for.

Kickers and defenses use the same machinery, measured against your **final pick of
the draft** rather than the next couple of rounds — the real choice there is one now
versus one with the last pick. Keeping them on a separate fixed rule while skill
positions moved to expected replacement put the two on different scales and made
K and DEF look far worse than they were.

The late-round gate on kickers and defenses blocks **selection only**, not
valuation — so they still carry real numbers in the overlay, annotated *held until
the last rounds*, rather than appearing as blank rows.

## Backup depth at RB and WR

| Parameter | Default |
| --- | --- |
| `BENCH_RB_WR_BOOST` | `0.10` |
| `OPPONENT_LATE_K_DEF` | `2` |

Injuries and bye-week holes are needed far more often at running back and receiver
than at quarterback or tight end, where a single starter usually suffices. This
multiplies the **ranking weight** of a bench-tier RB or WR, so depth there beats a
bench QB or TE of similar raw value.

It applies only to players in the `reserve` role — someone filling a starting slot
or flex is unaffected.

**It does not change the displayed number.** The overlay keeps showing the honest
points-over-replacement figure; only the sort order moves. A player promoted this
way is flagged `depth ×3 (rank only)` so the reason for their position is visible
without the value being misrepresented.

## Same-team bias

| Parameter | Default |
| --- | --- |
| `SAME_TEAM_PENALTY` | `0` |

A percentage reduction applied to a player's **projection** when you already hold
someone from his NFL team. `0` disables it entirely; `0.10` means a player from a
team you already own projects 10% lower for ranking purposes.

It is applied to the projection rather than the final value, so it flows through
the value-over-replacement maths exactly as a genuinely lower-projected player
would — it can move a player below replacement, not merely down the order.

The reduction **compounds** per teammate: with `0.10`, a second player from a team
you own projects at 90%, a third at 81%. It can push a player below replacement,
which is intended — the point is to express a real preference, not merely to break
ties.

**It does not apply to kickers or defenses.** A defense's output is not diminished
by owning that team's running back, and the stacking concerns the penalty exists to
express do not apply to those positions.

## 5. Last-second pick

| Parameter | Default |
| --- | --- |
| `AUTOPICK_AT_SECONDS` | `0` |

Seconds left on *your* clock at which the manager drafts the top of the queue
itself. `0` means never — let the clock expire and Yahoo take the queue top.

This is more than convenience. **Yahoo switches your team into autopick mode
whenever a pick timer actually expires**, and from then on every pick is made for
you until you switch it back off. Setting this to 2 means your timer never
expires, so that never triggers.

It is the only circumstance in which the manager drafts. Every other tick during
your turn it does nothing at all.

## Keeping control of your picks

Yahoo turns autodraft on by itself after an expired timer and shows a dialog
saying so. The manager watches for that dialog with a `MutationObserver` and
dismisses it immediately, then switches autodraft back off.

This is deliberately *not* on the periodic tick — a 2.5 second poll plus render
lag was too slow in a live test, and the dialog needs to be gone before the next
pick. The toggle is outline-styled when off and filled when on, with no ARIA
state to read, so it is detected by background colour.

## Tracking who has been drafted

Availability comes from the **Picks panel**, the tab immediately right of "Queue"
in the left column. It holds a rolling window of roughly seventy picks.

The draft header also carries a `Last: NAME (POS)` line, and that is read on every
tick because it is free. But it shows only ONE pick and turns over faster than any
poll when several teams autodraft back to back, so picks slip through unrecorded.
It is a supplement, never the source.

The Picks panel only exists in the DOM while its tab is active, so the manager
switches to it, reads the history, and switches back to whatever you were looking
at. That happens only immediately before the queue is regenerated — not on every
tick — so the UI stays still while you are working.

## Pool replenishment

The pool is read once at the start, top 100 per position. Once a position drops
below **50 available**, that position is re-read so late rounds still see a full
board rather than the dregs of the original pull.

The player table caps at 100 rows per view and does not lazy-load past it, which
is why the pool is pulled per position rather than as one deep Flex query.

## What the assistant assumes, and what it re-reads

You can reorder the queue, delete from it, add to it, or switch tabs at any moment,
and a reload wipes anything the script remembered. So it keeps **no durable model
of the queue**: it re-reads Yahoo's queue panel every cycle and every decision —
refill, prune, the overlay, the last-second pick — is made against what is actually
on screen.

The one thing it does assume is that **Yahoo does not change player data during a
draft**. Names, positions, teams, byes, projections and ADP are static, so the pool
is read once and reused. The only thing tracked over time is which players have
been drafted since the last pass.

## Rebuilding after your own pick

When you draft, the roster changes and every queued player was chosen against
needs that no longer hold. The manager purges the whole queue and rebuilds it.

## Queue composition

**No position may occupy more than `QUEUE_SIZE − 2` slots.** At the default queue
size of five, that is three. The queue exists to survive a run at a position, and
five variations on the same decision offer no protection at all — if that position
gets emptied, the whole queue is dead. Kickers and defenses are capped tighter
still (two, or one when picks are back to back).

The queue is a **sequence**, not a ranked list. Yahoo consumes it top-down, so each
entry is scored as if the ones above it were already drafted. That alone prevents
five kickers being queued for a one-kicker roster slot.

**One exception: the scarce-position backup.** When your next pick is not back to
back, the entry directly after a scarce pick is a same-position backup rather than
the next player in the sequence. If the drafter ahead of you takes your only
kicker, you want the next kicker at the top of the queue, not a receiver.

**That backup is disallowed when you pick twice in a row.** Autodraft would take
both and hand you two kickers. Spacing them further apart does not fix it — the
players in between can be sniped just as easily — so when picks are back to back
the queue is a strict sequence, hard-capped at one kicker and one defense.

Back-to-back picks are rarer than they look. In a snake the gap to your next pick
is `2(T−s)+1` after an odd round and `2s−1` after an even one, which equals 1 only
at the two endpoint seats (`s = 1` or `s = TEAMS`). Every middle seat always has at
least one opposing pick in between, so the backup is available to them on every
pick.

## Overlay

| Parameter | Default |
| --- | --- |
| `SHOW_OVERLAY` | `false` |
| `OVERLAY_CORNER` | `'bottom-right'` (vertical placement only) |
| `OVERLAY_RIGHT_OFFSET` | `330` (fallback only) |
| `OVERLAY_ROWS` | `6` |

A read-only panel showing the live ranking, each player's score decomposition, and
the health of the tracker — pool size, picks recorded, and whether autodraft is
currently off. Two of the silent failures found during development would have been
visible immediately on that last line instead of only in a dump afterwards.

It sits **just left of your roster column**, overlapping the bottom-right of the
player table rather than hiding your team. The roster panel's left edge is measured
at render time so this adapts to window width; `OVERLAY_RIGHT_OFFSET` is used only
when that measurement fails.

It is a `position: fixed` div appended to `document.body`, so it is a sibling of
Yahoo's tree and never perturbs it. It sets **`pointer-events: none`**, which makes
it transparent to the mouse: clicks pass through to whatever is underneath, so it
cannot intercept one or cause a stray draft even if it sits over the Draft button.

It hides itself whenever a `[role=dialog]` is present, so it can never cover the
autopick dialog you need to see and dismiss.

## Entries you queued yourself

Anything in the queue that the assistant did not add is treated as yours and is
**never removed** — not by prune, not by the post-pick rebuild, not by the
per-position limit. Your entries still count toward queue size and toward
planning, so the assistant simply stops adding around them rather than
overruling you. They are marked with a ◆ in the overlay.

Ownership is recorded per draft room in `localStorage`, because a reload would
otherwise make the assistant's own earlier additions look like yours and freeze
the queue permanently. The queue itself is still read live every cycle; this only
records who put each entry there. In a room with no record, everything already
present is treated as yours, which is the safe default.

## Never during your turn

The manager does not touch the queue while it is your turn, without exception — a
click landing under your cursor could draft someone you did not choose. Its only
action during your turn is the `AUTOPICK_AT_SECONDS` safety net, which drafts the
queue top with the clock nearly expired.

## Kickers and defenses

These are not valued like everyone else, and the difference is deliberate.

For skill positions, replacement level is *what you could still get at your next
turn* — the relevant question is whether to take this player now or wait one
round. For kickers and defenses that framing is wrong, because nobody drafts a
second one. The real choice is **take one now, or take one in the final round**;
there is no meaningful middle.

So their replacement level is the best one still on the board after every other
team has taken theirs — `TEAMS − 1` deep in the position list. What the manager
scores is the genuine surplus of spending a pick now rather than waiting until the
end, which is usually close to zero, which is why they correctly stay out of the
queue until late.

## Must-fill override

When the number of unfilled required positions equals the number of picks you have
left, the manager queues only those positions. Permitting a defense late is not
the same as requiring one — an earlier version ended a draft with zero defenses
because the fallback preferred a tight end.
