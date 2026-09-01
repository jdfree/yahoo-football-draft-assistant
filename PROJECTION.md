# Projection algorithm

How the assistant decides what a pick is worth. This replaces the ADP-based
replacement model, which was wrong in a way that mattered: it predicted *who gets
drafted* from average draft position, when in a real room people draft by value
against their own roster holes.

The output we actually need is narrow — **the calibre of player likely to still be
available at our subsequent pick, per position**. Everything below exists to
produce that number.

---

## 1. League baseline — computed once, never recomputed

Establish what a *starting-calibre* player looks like at each position. This is a
property of the league's shape, not of who happens to be undrafted, so it is
computed once and frozen. Literally once: the function returns early ever after.

That makes league size something the assistant must know **before** it computes,
not something it can correct later — so it waits until the size is *confirmed*
rather than assuming a default. Slot is easy: it is in the draft-room URL.

Team count is **counted, not inferred**. The room renders the whole draft order —
for a 14-team, 15-round draft, 210 entries — and a snake order mirrors at the
turn: `... Hugh, Ira, Ira, Hugh ...`. The position of that mirror is the team
count. It is available from the first pick, it is positional so duplicate manager
names cannot break it, and the mirror doubles as a check: the first `2T` entries
must read the same forwards and backwards. The container's class names are
obfuscated and change between rooms, so it is found by that structure rather than
by selector.

If the strip is not up, team count falls back to narrowing from the header. Every
`ROUND r, PICK n` is a constraint, since pick `n` falls in round `r` exactly when
`(r-1)·T < n <= r·T`: round 1 pick 14 gives `T >= 14`, round 2 pick 15 gives
`T < 15`, so `T = 14`. That resolves only at the first pick of round 2, which
costs the projection for round 1 — acceptable, since queueing by ADP is almost
always what you want in round 1 anyway.

Two rejected sources, both tried live:

- **The room's list of our own picks** (`Round 1, Pick 7 (7th Overall) / Round 2,
  Pick 8 (22nd Overall)`) gives `T = (7 + 22 - 1) / 2` directly, and is used when
  present — but it is not rendered in every room, and never before the draft
  starts.
- **Counting distinct drafters in the picks feed** is wrong twice over. Early on, the number of
  drafters trivially equals the number of picks: at pick 4 of a 14-team room it
  "confirmed" four teams and froze the baseline against them. And drafter names
  are not unique — one live room held two `Mark`, two `Marcuss` and two `Jason`,
  which would have merged six teams into three. It survives only as a last resort,
  and only once the order has visibly wrapped.

Inputs: the roster slots (e.g. QB, WR, WR, RB, RB, TE, W/R/T, K, DEF) and the
number of teams. Flex (`W/R/T`) means RB, WR or TE.

1. Count league-wide starting slots per position: `teams × slots at that position`.
   With 12 teams: 12 QB, 24 RB, 24 WR, 12 TE, 12 K, 12 DEF, and 12 flex.
2. Sort every player by **unmodified projected points**.
3. Fill the dedicated slots from the top down — the top 24 RBs are RB starters, and
   so on.
4. Fill the flex slots with the best remaining RB/WR/TE by projection.
5. For each position, the **worst starter** is the lowest projection among the
   players assigned to a starting slot there (dedicated or flex).

This yields one number per position: the projection of a replacement-level
starter. Everything downstream is measured against it.

**It must be computed from the full player pool, including players already
drafted.** If the assistant is armed mid-draft, the undrafted pool is missing all
the best players and the baseline would be far too low.

Two things protect it.

**The snapshot is frozen.** The pool is captured the first time the baseline is
computed and reused for any recomputation — for instance when league size is
corrected. Recomputing from the live pool walks the baseline steadily downward as
the draft proceeds: observed live, RB fell from 108.4 to 92.6 purely because
thirty-five players had been drafted in between.

**Drafted players are read back in.** Yahoo's `Drafted` pill widens the player
table to include players already taken, carrying the same projection column. At
arm time the assistant toggles it, sweeps the positions, and merges those
projections into the baseline pool before computing. Without this, arming
mid-draft is badly wrong in a way that is easy to miss — at pick 111 the RB
worst-starter read 51.87 against a true figure near 108, which makes every
remaining running back look like a franchise cornerstone.

The merge is **by Yahoo id**. The pill shows all players rather than only the
taken ones, so the two reads overlap almost entirely; concatenating them counted
every elite player twice and filled twenty-eight starting slots with fourteen
players, pushing RB the other way to 151.

Both failures were silent — a wrong baseline throws nothing, it just misprices
every pick — so the computation now checks itself: the number of players at or
above the baseline must match the number of starting slots at that position, and
a mismatch is logged.

## 2. Predicting the picks between now and our subsequent pick

**Run once per round, asynchronously, and cached.** The output is one number per
position — the best projection expected to still be there at our subsequent pick
— and that does not meaningfully change between two picks of the same round.

This matters for more than tidiness. The simulation used to run inside the
ranking, and `planQueue` calls the ranking once per queue slot: eight full
simulations of up to thirty picks over a five-hundred-player pool for a single
refill, all synchronous. That froze the tab.

Two survivors are cached per position rather than one, so a player is never
measured against himself — the bug that had the top receiver score zero surplus,
the model concluding that passing on him would leave him available.

### Which picks to simulate

From the most recent actual pick through our **subsequent pick**, defined as:

- normally, the pick *after* our next pick, counting from the pick after the one
  being decided;
- if our next two picks are consecutive (only possible at the turn, when the snake
  gap is 1), the pick after that *pair*.

The point is to look one real decision beyond our imminent one, because that is
the horizon over which a position can be stripped. Deciding in round 1 therefore
looks to our **round 3** pick, not round 2.

Counting from the current pick instead got this wrong by a full round, because
"our next pick" then resolved to the decision in hand: at slot 9 of 14, deciding
at pick 9 looked only as far as pick 20 rather than 37. Every candidate was priced
against a one-round horizon, which understates how far a position gets stripped
and penalises running backs most. Live consequence: a quarterback topped the
round-1 queue on a 28-point edge measured against round 2, while the running
backs' real cost against round 3 was never measured.

### How each team picks

For each simulated pick, take that team's roster as it stands and:

1. **If the team has unfilled starting slots**, consider only positions that fill
   one. Choose the available player with the greatest `projection − worst starter
   at his position`.
2. **If every starting slot is filled** (or becomes filled mid-simulation), consider
   all positions using the same surplus, but inflate an RB's or WR's **projection**
   by `BENCH_RB_WR_BOOST` — bench depth is needed far more often at those positions.

   The boost lands on the projection, never on the surplus. Scaling a surplus
   scales whatever happens to be there: a back sitting far above baseline was
   tripled while a receiver sitting just below baseline floored at 1 and could
   never win a pick. The simulation drafted 28 running backs and no receivers in 31
   picks, which collapsed the RB floor and inflated every back's surplus in turn.
3. **Kickers and defenses wait.** Opponents are modelled as leaving them until the
   last `OPPONENT_LATE_K_DEF` rounds. A kicker scores positive against baseline
   from round one, so without this the simulation drafts them constantly — 11
   kickers and 11 defenses in 29 picks — and never touches the skill positions that
   are actually disappearing. A team whose only remaining gaps are a kicker and a
   defense falls through to bench depth rather than drafting nobody.

4. **Bye-week limit:** a team will not take a third player at one position sharing a
   bye week. If it already holds two such, that position is skipped for players on
   that bye.
5. **Negative surplus floors to +1.** Late in a draft every remaining player is
   below starter calibre; without a floor the comparison degenerates. A pick still
   happens, so treat the best option as marginally positive.
6. **Ties break toward RB.**

This is a heuristic model of a rational drafter, not a simulation of any particular
opponent. It will be wrong about individual picks. It only has to be roughly right
about *how many* players at each position disappear.

### Actual rosters versus projected rosters

These are kept strictly apart. `state.teamRosters` holds only what has really been
drafted, and changes solely when a pick is observed in the feed. The simulation
forks a copy and adds imaginary picks to that.

Every queue rebuild re-forks from the current actual rosters, so a projection is
never seeded with the previous projection's guesses — otherwise imagined picks
would compound into the next run and drift further from the draft with every pass.

## 3. Valuing our own candidates

- Every currently undrafted player is a candidate for our queue. The simulation
  never removes anyone from consideration.
- A candidate's surplus is `projection − the projection expected to still be
  available at his position at our subsequent pick`, taken from the simulation.

- **Against the best survivor, for every candidate.** We make one pick now, so
  passing on a position leaves us the best player still there at the horizon —
  whoever we would otherwise have queued. That single figure is the true cost of
  forgoing the position this round, and it is what makes the number react to runs:
  when the simulation predicts a run on running backs, the floor drops and every
  back's surplus rises together.

  **Negative surplus is a signal, not a defect.** It says this player is likely to
  still be available at the horizon, so the pick is better spent elsewhere. An
  attempt to index a ladder of survivors — measuring the Nth queued back against
  the Nth rung — made those numbers positive, but against a bar nobody actually
  faces, and it hid exactly the signal the number exists to give.

So the simulation answers "what will I be able to get instead, if I pass", and the
candidate is worth the difference.

**For the flex slot the question is asked across positions.** Flex is one slot
contested by every RB, WR and TE, so the alternative to passing is the best
flex-eligible player left, not the best at the candidate's own position. Measuring
a tight end for flex against the tight-end bar credits him for scarcity that was
already spent on the dedicated TE slot, and that bar is far below RB's — which is
how a 162-point TE came to outrank a 185-point RB for the same slot.

---

## Why the previous model failed

Recorded so the same mistakes are not reintroduced.

- **A player was his own replacement.** Replacement was computed once per position
  and reused, so the best available player at a position compared against himself
  and scored zero. The model concluded that passing on the top receiver would leave
  the top receiver available.
- **ADP was treated as a promise.** A hard cutoff said a player with ADP 130 would
  certainly last to pick 129. ADP is an average, and the top-projected player at a
  position is exactly who a value-drafter reaches for early.
- **Most of the pool has no ADP at all** — 352 of 488 players in one live draft.
  Stored as 999, they were never predicted to be drafted, ever.
- **Counting by one signal and indexing into another.** Departures were counted by
  ADP, then removed from the top of the *projection* list, as if the players taken
  were the highest-projected. Where the two disagree — which is exactly where the
  value is — this was simply wrong.

The common thread: ADP describes an aggregate market, and we were using it to
predict twelve specific decisions. Modelling the decisions directly is the fix.

## Where the opponent rosters come from

Every entry in the Picks feed carries the drafting team's name alongside the
player, position, NFL team and bye:

```
67  Tyler Polycranos   J. DANIELS      QB · Was · Bye 7
68  You                T. HENDERSON    RB · NE  · Bye 11
```

So each team's roster is accumulated from the picks already being parsed for
availability — no separate board scraping, and no extra tab switching beyond the
one already made to read that feed. Recording the drafter turns a list of gone
players into twelve rosters for free.

## Known gaps

- **The picks feed is windowed** at roughly seventy entries. Arming from the first
  pick captures everything; arming mid-draft loses the earliest picks, leaving
  those teams' rosters incomplete. The baseline no longer suffers from this — it
  reads the drafted players back in — but roster attribution still does, so the
  simulation starts from partial opponent rosters when armed late.
- **Opponent behaviour is assumed rational and uniform.** Real rooms contain
  homers, reachers and autodrafters. The model has no notion of any of them.
