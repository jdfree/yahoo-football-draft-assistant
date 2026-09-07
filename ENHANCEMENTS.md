# Future enhancements

Wanted, not built. Each entry says what it is, and what already exists that helps
or gets in the way — the split between `strategy.js` (the algorithm) and
`queue-manager.user.js` (everything that talks to the draft room) is what most of
this depends on, and it is already in place.

---

## The decision to make first

Everything below falls into one of two projects, and they pull in different
directions. Worth deciding deliberately — or deliberately forking — rather than
drifting into both.

**Augment the draft platform's UI.** Better information on the board: surpluses
on every row, floors, positional runs, opponent needs, tier breaks. The assistant
already does a little of this with the floors strip and the queue annotations, and
it is the more immediately satisfying work because you see it every pick.

**Implement strategies.** Valuation, variance, alternative projections, risk
preferences, an AI in the loop. Invisible next to a nice overlay, and the reason
the tool produces a different answer from everyone else's.

Three things to weigh.

**Check the paid tier before building any UI.** Yahoo already sells draft
assistance — the Draft Scout panel, Fantasy Plus, Instant Mock Drafts are all
visible in the room behind a subscribe wall. Before spending a weekend on a
feature, find out whether it already ships there. Rebuilding something the
platform sells is wasted effort twice over: it exists, and their version will not
break every time they redeploy the room.

**The two have very different maintenance costs.** UI work is coupled to the
draft room's DOM, which is obfuscated, changes between rooms, and has already
broken this project repeatedly — the clock scanner, the queue drag handles, the
picks feed. Strategy work sits behind the `strategy.js` boundary, runs in plain
Node with no browser, and is testable in a second (`node strategy-smoke.js`). One
of these accrues debt with every Yahoo deploy; the other does not.

**They are cleanly separable now**, which is what makes forking a real option
rather than a mess. UI belongs to the adapter, strategy belongs behind the
interface, and neither needs the other to change.

The honest read: strategy is where this can be better than a paid product, and UI
is where it is most likely to duplicate one. But a strategy nobody can see the
output of is hard to trust or tune — so if it is both, the UI work worth doing is
whatever *explains* the strategy's reasoning, not whatever looks best.

---

## 1. Other fantasy platforms

Today the assistant only knows Yahoo. Everything platform-specific already lives
on one side of the boundary — reading the board, clicking, dragging, tab state,
the clock — so a second platform means a second adapter, not a second algorithm.

What an adapter has to provide:

- the player pool, with projections and ADP
- who has been drafted, and by whom
- our roster, our slot, the league size, the roster shape
- the current pick and the clock
- the ability to add, remove and reorder queue entries

That is the `ctx` snapshot plus the queue actions. ESPN, Sleeper and NFL.com are
the obvious targets. Sleeper has a public API, which would make it far less
brittle than scraping a React app.

The harder part is not the data but the **queue model**. The whole design rests on
Yahoo drafting the top of your queue when the clock expires. A platform without
that has no safety net, and the assistant would have to either draft directly or
become advisory only.

---

## 2. Rules and projections from configuration

Two related gaps.

**Scoring rules in a config file.** Right now nothing knows the league's scoring —
it does not have to, because Yahoo publishes `Proj Pts` already scored under that
league's rules. That is convenient and it is also a hard dependency on Yahoo doing
the arithmetic for us.

Worth recording, because it was investigated and is not obvious: **Yahoo does not
publish the point values anywhere in the draft flow.** The waiting room lists
*which* categories are scored (Passing Yards, Interceptions, FG 40-49, Points
Allowed brackets…) but never what each is worth, there is no rules or settings
link, and the draft room has neither. The values are recoverable anyway, because
the player table carries both the projected stats and the resulting `Proj Pts` —
one equation per player against roughly a dozen unknowns, solvable by least
squares per position group. Verified by hand for a quarterback under standard
scoring:

```
3606×0.04 + 25.8×4 − 9.7 + 511×0.1 + 7.6×6 + 2.1×2 − 2.6×2 = 333.44   (Yahoo: 333.73)
```

The residual is display rounding on the stats.

**Alternative projection sources.** Once scoring is expressed as per-stat weights,
any projection source can be scored under this league's rules — FantasyPros,
Rotowire, a spreadsheet, a personal model. That is the real prize: it decouples
*whose numbers* from *how they are valued*, and it is what makes the assistant
useful in a league where you disagree with Yahoo's projections.

The player table already exposes the stat columns, in three position-specific
sets: offense (Pass Yds, Pass TD, Int, Rush Att, Rush Yds, Rush TD, Targets, Rec,
Rec Yds, Rec TD, Ret TD, 2-PT, Fum Lost), kickers (FG by distance band, PAT), and
defense.

---

## 3. Variance, and strategies that act on it

Every projection is currently a point estimate, and the valuation treats a 200-point
running back and a 200-point quarterback as interchangeable at the same surplus.
They are not, and drafters know it — which is why real boards take extra backs and
receivers, chasing upside at the positions that vary most and miss time most often.
None of that variance is in the data available today, so the model does not attempt
it, and its measured tendency to over-predict quarterbacks going early is partly
that gap showing.

What to allow specifying:

- **Per-position variance.** RB and WR spread wider than QB and TE.
- **Asymmetry by tier.** Elite players plausibly carry more downside than upside;
  late players the reverse, being closer to a floor of zero.
- **Per-player overrides**, for injury risk, a rookie, a new scheme.

Then let a strategy *act* on it rather than just report it. Different strategies
want different things from the same distribution — maximise expected points,
maximise the chance of a top-quartile season, minimise the chance of a bust — and
those produce genuinely different boards. This is a natural fit for the strategy
interface: a variance-aware strategy is a drop-in replacement, not a rewrite.

The self-scoring record (ALGORITHM.md, section G) is the way to tell whether any
of it helps, and it should be the bar any such strategy has to clear.

---

## 4. An AI drafting alongside a human

The end state: connect a model to the live draft and let it pick with you, with
this software as the interface — effectively an **MCP server** over the draft room.

The tools it would expose are close to what the adapter already provides
internally: read the board, read the rosters, read the floors and surpluses, queue
a player, reorder the queue, draft a player. A model could then reason about
things the arithmetic cannot — a beat writer's report, a coordinator change, how
this specific league drafts, what your opponents visibly need.

The division of labour that seems right: the software supplies the priced board
and the queue, and holds the safety net; the model and the human argue about the
pick. The queue stays the fallback, so an unavailable or slow model costs nothing.

---

## 5. Targets and exclusions

A list of players you want, and a list you refuse. Both are ordinary requests that
the current design has no place for.

- **Targets** — bias toward these players, or hold a slot for one when he is
  plausibly still there at the next turn.
- **Player blacklist** — never queue him, whatever the numbers say.
- **NFL team blacklist** — never take anyone from a team, for the same reason
  people avoid a backfield they think is a committee.

`Q7` (veto) already does a crude version of the blacklist by watching what you
pull out of the queue three times, and `SAME_TEAM_PENALTY` is a soft version of
the team rule. Both are behavioural inferences; an explicit list is clearer, and
should be config, not something the assistant has to guess.

---

## 6. A startup wizard

`start.sh` currently starts a server and prints a bookmark. Everything else is a
default in `queue-manager.user.js`, changed by hand-editing `window.YS_CONFIG` in
a console — which is fine for the parameters nobody touches and poor for the ones
that vary by league.

A wizard would ask once, write the answers to a config file, and reuse them:

```
./start.sh                 # reuse the saved config
./start.sh --configure     # walk through the questions again
```

What it should ask about, roughly in the order it matters:

- **League shape** — roster slots, flex count, roster size, per-position caps.
  Everything downstream rests on this, and it is the one thing that must be right
  before the draft starts, because the baselines are computed once and frozen.
- **Playoff weeks**, so the ESPN team context matches the league.
- **Queue size**, and whether to run live or watch in dry run.
- **Targets and exclusions**, once §5 exists.
- **Strategy**, once there is more than one to pick from.

Not slot or league size — those are detected from the room and override config, and
asking for them invites a wrong answer that quietly contradicts what is detected.

Two things worth getting right. The config should be a **plain file the user can
edit and keep in the repo**, so a league can be set up once and reused every year,
and re-running the wizard should start from the existing answers rather than from
defaults. And the wizard should be skippable — the defaults already run a standard
league correctly, and a first-time user should not have to answer a dozen
questions before their first mock.
