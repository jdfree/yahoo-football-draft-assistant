---
name: fantasy-draft
description: Draft co-pilot for the Yahoo league "Lord of Lifers et al" (ID 813836) — an offline draft with heavily customized scoring. Use when the user is drafting or prepping to draft: "I'm on the clock", "who should I take", "draft help", "my pick", "board", or any question about who to draft in that league.
---

# Draft co-pilot — Lord of Lifers et al (813836)

## Read STRATEGY.md first

`STRATEGY.md` in this repo is the user's own instructions and the authority on how
to draft. Read it at the start of every draft session and follow it.

Its "Locked facts" section is verified data. The "Your strategy" section is the
user's, and it wins. If their stated strategy conflicts with what the projections
say, do the thing they asked for and say once, briefly, what the data suggests
instead — then drop it. Do not relitigate on every pick.

## The draft is offline

There is no Yahoo draft room. The commissioner enters picks afterward, so Yahoo
never sees the draft happen. Two consequences:

- **No automation applies on draft night.** The autodraft userscript
  (github.com/jdfree/yahoo-football-autodraft) drives a live draft room; there
  isn't one. It's for mocks only.
- **Yahoo's available-player pool is useless during the draft.** It will report
  every player as available all night. Track the board from what the user tells
  you: they say each pick as it happens, you maintain the taken list.

## Build the board

Run `extract-board.js` via the browser (Claude in Chrome `javascript_tool`) on any
`football.fantasysports.yahoo.com` page while logged in. It pulls ~300 players
whose projections Yahoo has **already scored under this league's custom rules**,
then computes value over replacement for a 12-team roster.

Refresh it the morning of the draft. Preseason injuries move the numbers.

It leaves `window.__board` in the page. Slice it rather than re-fetching:

```js
window.__board.filter(x => !taken.has(x.n)).sort((a,b) => b.v - a.v).slice(0,12)
  .map(x => `${x.n}|${x.p}|v${x.v}|bye${x.bye}`)
```

The `rk` field is Yahoo's preseason overall rank and is **not** league-adjusted.
`proj` and `v` are. A player with poor `v` but strong `rk` is one the rest of the
room will overdraft — let them.

## On the clock

Lead with the name. One line of why. Two fallbacks. No preamble, no tool
narration.

```
**Trey McBride (TE, ARI)** — biggest positional edge left; TE1 to TE12 is an
85-point cliff and Yahoo ranks him 30th.
Fallbacks: Jeremiyah Love (RB, v71) · Zay Flowers (WR, v62)
```

Weigh in this order: value over replacement, then picks until the user's next turn
(slot 3 waits 19 picks between rounds 1 and 2 — the longest gap in the draft), then
bye collisions after round 8, then handcuffs with the last two bench spots.

Honor the cautions in `STRATEGY.md` — especially verifying large
projection-vs-rank gaps before spending an early pick on one.

## After the draft

`ff_get_draft_results` stays empty until the commissioner enters picks. Grade off
the board instead: sum the starters' projections, name the thinnest position, and
list the best undrafted players by `v` as week-1 waiver targets.
