# yahoo-football-draft-assistant

Personal draft co-pilot for the Yahoo league **Lord of Lifers et al** (ID# 813836),
team *Purdy Good*, drafting from slot 3.

The league drafts **offline** — no Yahoo draft room, the commissioner enters picks
afterward. So this repo is a co-pilot, not an automaton: it builds a board under
the league's real scoring, and you tell it picks as they happen.

For automating a *live* Yahoo draft room or a mock, see the separate
[yahoo-football-autodraft](../yahoo-football-autodraft) repo.

## Contents

| File | What it is |
| --- | --- |
| `STRATEGY.md` | **The input.** Your draft instructions. Edit this. |
| `SKILL.md` | The Claude skill. Reads `STRATEGY.md` and follows it. |
| `extract-board.js` | Pulls ~300 players with projections already scored under this league's rules, ranked by value over replacement |
| `draft-board.html` | Source of the published round-by-round cheat sheet |

## Install

```bash
ln -s ~/git/yahoo-football-draft-assistant ~/.claude/skills/fantasy-draft
```

Then edit `STRATEGY.md`. Claude reads it at the start of every draft session and
treats your wording as authoritative.

## Why the scoring matters here

This league pays **0.5 per completion** (Yahoo default: 0) and **6 per passing TD**
(default: 4). That inflates every quarterback into the 420–540 range, which reads
as "quarterbacks are enormously valuable."

It is the opposite. The rule lifts the floor as much as the ceiling, so 75 points
separate QB1 from QB18 where 117 separate RB1 from RB18. Quarterback is the
flattest position on the board, and every default ranking gets this wrong for this
league.

Details, and the derived round-by-round plan, are in `STRATEGY.md`.

## Refreshing the board

Run `extract-board.js` through Claude in Chrome on any logged-in
`football.fantasysports.yahoo.com` page. Do it the morning of the draft —
preseason injuries move the numbers, and the pull in `STRATEGY.md` is from
2026-08-27.
