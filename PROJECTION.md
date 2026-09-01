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
computed once and frozen.

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

## 2. Predicting the picks between now and our subsequent pick

Run before each queue repopulation.

### Which picks to simulate

From the most recent actual pick through our **subsequent pick**, defined as:

- normally, the pick *after* our next pick;
- if our next two picks are consecutive (only possible at the turn, when the snake
  gap is 1), the pick after that *pair*.

The point is to look one real decision beyond our imminent one, because that is
the horizon over which a position can be stripped.

### How each team picks

For each simulated pick, take that team's roster as it stands and:

1. **If the team has unfilled starting slots**, consider only positions that fill
   one. Choose the available player with the greatest `projection − worst starter
   at his position`.
2. **If every starting slot is filled** (or becomes filled mid-simulation), consider
   all positions using the same surplus, but apply the backup depth multiplier
   (`BACKUP_RB_WR_WEIGHT`, default 3) to RB and WR — bench depth is needed far more
   often at those positions.
3. **Bye-week limit:** a team will not take a third player at one position sharing a
   bye week. If it already holds two such, that position is skipped for players on
   that bye.
4. **Negative surplus floors to +1.** Late in a draft every remaining player is
   below starter calibre; without a floor the comparison degenerates. A pick still
   happens, so treat the best option as marginally positive.
5. **Ties break toward RB.**

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
- A candidate's surplus is `projection − the best projection expected to still be
  available at his position at our subsequent pick`, taken from the simulation.

So the simulation answers "what will I be able to get instead, if I pass", and the
candidate is worth the difference.

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
  those teams' rosters incomplete and the baseline computed from a pool that is
  missing its best players.
- **Opponent behaviour is assumed rational and uniform.** Real rooms contain
  homers, reachers and autodrafters. The model has no notion of any of them.
