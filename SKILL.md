---
name: draft-assistant
description: Fantasy football draft assistant. Reads the live draft board and NFL team context, then recommends picks. Use when the user is in or preparing for a fantasy football draft, mock or real — "I'm on the clock", "who should I take", "draft help", "start the draft", "read the board".
---

# Draft assistant

Works for mock drafts and real drafts alike. Two data sources, gathered at
different times, then used together for every pick.

## 1. Team context — any time before the draft

```bash
node fetch-team-context.js
```

Pulls ESPN's Football Power Index and the full season schedule grid, joins them,
and writes `team-context.json`: per team its FPI, offensive/defensive/special-teams
EPA, bye week, full 18-week schedule, and strength of schedule for both the whole
season and the fantasy playoff weeks.

Static preseason data — no draft room needed, and it does not change during the
draft. Refresh it the morning of. Use `--playoffs 15,16,17` to match the league's
playoff weeks.

It self-validates: 272 games, one bye per team, every matchup reciprocated with
opposite home/away. If ESPN changes their page structure it fails loudly rather
than producing a half-parsed table.

## 2. Player pool — immediately at draft start

The draft room publishes projected points for every player, **already scored under
that league's rules**, plus ADP. This never changes during the draft, so read it
once, as soon as the room opens, and cache it.

Read depth:

| Positions | Depth |
| --- | --- |
| QB, TE | top 75 each |
| WR / RB / Flex | top 300 |
| K, DEF | all |

Capture at minimum: name, position, NFL team, projected points, ADP, bye week.

Speed matters here — the read must land before the first picks are made, so favour
one bulk pass over incremental scraping.

## 3. During the draft

Never carry an external ranked board and match players by name. The draft room
abbreviates to a first initial and initials collide — `B. Robinson` and `J. Love`
each match two different players at two different positions. Work from the row you
evaluated, and click that same row.

Value a player as:

```
raw   = projected points − best projection at that position still expected at your next turn
value = raw × 1.0   fills an empty starting slot
        raw × 0.9   fills flex
        raw × 0.2   bench only
```

Estimate attrition with ADP: the `gap` lowest-ADP players come off the board before
your next turn, where `gap` is the snake distance (`2 × (teams − slot) + 1` in odd
rounds, `2 × slot − 1` in even rounds).

This prices positional scarcity without being told the scoring rules. A position
where everyone projects similarly is correctly treated as low-value even when the
raw numbers look huge.

Layer team context on top: strength of schedule during the fantasy playoffs, and
bye-week collisions among players you already hold.

## On the clock

Lead with the name. One line of why. Two fallbacks. No preamble, no narration of
tool calls.

```
**Trey McBride (TE, ARI)** — biggest positional edge left; the drop to the next
tight end is 60 points.
Fallbacks: Jeremiyah Love (RB, v71) · Zay Flowers (WR, v62)
```

## Keeping the roster legal

- Force any unfilled required position once rounds remaining equals slots missing.
  Permitting a defense late is not the same as requiring one.
- Exclude players already rostered — re-picking one is a silent no-op.
- Kickers and defenses in the final two rounds only.
