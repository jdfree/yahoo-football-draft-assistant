---
name: yahoo-football-autodraft
description: Autodrafts a Yahoo fantasy football draft or mock draft by optimizing on the draft room's own projected points. Use when the user wants to automate a Yahoo draft, run a mock draft unattended, test a draft strategy, or asks who to pick while a Yahoo draft room is open.
---

# Yahoo fantasy football autodraft

Drives a Yahoo draft room from the browser, picking on value rather than on a
pre-written cheat sheet. Ships as a Tampermonkey userscript
(`yahoo-draft-autopilot.user.js`) that you configure and run in the draft room.

Everything below was established by running live mock drafts, not from
documentation. Yahoo publishes none for this.

## The core idea: never bring an outside list

The draft room's player table already has a **`Proj Pts`** column, computed under
*that league's* scoring rules. Read it, value the row, and click the button inside
the row you just evaluated.

The tempting alternative — precompute a ranked board elsewhere, then find each
player by name in the room — is the single largest source of catastrophic error.
The room abbreviates names to a first initial, and initials collide:

| Wanted | Got |
| --- | --- |
| Bijan Robinson (RB-Atl) | Brian Robinson (RB-Atl) |
| Bijan Robinson | Wan'Dale Robinson (WR-Ten) |
| Jeremiyah Love (RB-Ari) | Jordan Love (QB-GB) |
| Javonte Williams (RB-Dal) | Jameson Williams (WR-Det) |

Matching on surname alone drafted four wrong players in six rounds and logged all
four as successes. Even initial + surname + position + NFL team still collides
(Brian and Bijan Robinson were both Atlanta running backs). Working off the row
you evaluated makes the whole class of bug impossible.

## Valuation

Raw value is **`proj − (best projection at that position still expected at your
next turn)`**.

Attrition is estimated by taking the `gap` lowest-ADP players off the board, where
`gap` is the snake distance to your next pick: `2 × (teams − slot) + 1` in odd
rounds, `2 × slot − 1` in even rounds. From slot 3 of 12 that alternates 19 and 5.

This prices positional scarcity automatically. In one mock, quarterbacks projected
280–305 while running backs projected 137–190, and the model still correctly
ignored nearly every quarterback — because the *next* available quarterback also
projected ~290, so the marginal gain was tiny.

Then scale by whether the player can actually start:

| Fills | Multiplier |
| --- | --- |
| An empty starting slot | ×1.0 |
| Flex (W/R/T) | ×0.9 |
| Bench only | ×0.2 |

Without that scaling it drafted a second quarterback at +17.9 while already
holding one — correct against league-wide replacement, worthless in reality.

## Setup

1. Install Tampermonkey, add `yahoo-draft-autopilot.user.js` as a new script.
2. Open the draft room and **read your actual slot off the waiting-room page**.
   Joining is racy: on two of four attempts a requested slot 3 came back as
   position 9 and position 12, with only a one-line notice. Set `CFG.SLOT` to what
   you were actually assigned, and `CFG.TEAMS` to the league size.
3. Leave `DRY_RUN: true` and run a full mock. Read `window.__autopilotLog` end to
   end before trusting it.
4. Only then set `DRY_RUN: false`.

The dry run is not a formality. Four consecutive live runs each surfaced a new
parser assumption that looked fine until real data hit it.

## Draft room facts

- Room URL `/draftclient/f1/<mlid>/<slot>`; mock lobby `/f1/<league>/mock_lobby`.
- Player table header: `Queue | Player | XRank | ADP | Bye | Proj Pts | GP | …`.
  Resolve columns by header text, never by index.
- **Turn signal**: title `YOUR TURN, DRAFT NOW`, or header `YOUR TURN •`.
  - Do *not* test `/YOUR TURN/` — "10 picks until your turn" matches it and fires
    on other teams' picks.
  - "You are next" is the pick *before* yours. Clicking then is a no-op that
    forfeits the pick to autodraft.
- **Your roster is the panel headed `YOUR TEAM (n/m)`.** Other panels show
  whichever team is currently picking and will silently read as your own. The `m`
  is the true roster size — mocks use 15 where the parent league uses 14.
- Parse position as the token immediately before team + `Bye`. A bare `\bK\b`
  matches the *initial* in `K. Walker III` and files a running back as your kicker.
- Team defenses render as `Lions DEF Bye 6` — no initial, no team abbreviation. A
  parser expecting `X. Lastname` misses them entirely, under-counts the roster,
  and reports a phantom missing defense.
- Rows recycle constantly; evaluate and click within the same tick.
- The lobby countdown is elastic — it advances as the room fills, not in real time,
  so you cannot predict when a draft starts.

## Winning the turn

The draft tab usually runs with `document.hidden === true`, and browsers throttle
background timers to ≥1s. A `setInterval` poll loses roughly half its turns to
Yahoo's own autodraft.

A `MutationObserver` fires on the same task as the DOM change and is not throttled
that way. After switching, every contested pick was won. Keep the interval only as
a safety net.

But order the work cheaply: the observer fires on *every* mutation and the room
mutates about once a second as the clock ticks. Check `myTurn()` before ranking
100 rows, or you will peg the renderer.

## Rules that keep the roster legal

- **Force any unfilled required position** once rounds remaining equals slots
  missing. Permitting a defense from round 13 is not the same as requiring one; a
  draft ended with zero defenses because the fallback preferred a tight end.
- **Exclude players already on your roster.** Re-picking one is a silent no-op,
  and the forfeited pick goes to autodraft.
- **Stop when the roster is full**, and only mark a pick handled once the roster
  count actually increases — a click on a stale row otherwise records as success.
- Kickers and defenses only in the final two rounds.

## What a mock can and cannot tell you

Mock drafts inherit roster positions and team count from the parent league, but
**not custom stat modifiers**. A league scoring 0.5 per completion showed no
completions category in its mocks.

So a mock validates the *automation* — turn handling, parsing, roster rules. It
cannot validate a *strategy* that depends on custom scoring.

## Before you use this

Yahoo's general Terms of Service prohibit accessing the service with "robots, web
crawlers, spiders, ants, and scrapers" and interacting other than through the
provided interface. Mock drafts are the lowest-stakes place to run this — no
prizes, no standings, no effect on anyone's league — but the account risk is not
zero. Prefer near-empty mock rooms, which fill with Yahoo's own bots rather than
with people practicing for their real drafts.
