# yahoo-football-draft-assistant

A fantasy football draft assistant. Works for mock drafts and real drafts.

It builds its picture from two places: NFL team strength and schedule from ESPN,
gathered before the draft, and the live player pool read out of the draft room the
moment it opens. Both feed a single valuation that prices positional scarcity
without needing to be told the league's scoring rules.

To automate a Yahoo draft room end to end instead, see
[yahoo-football-autodraft](https://github.com/jdfree/yahoo-football-autodraft).

## Team context

```bash
node fetch-team-context.js                 # writes team-context.json
node fetch-team-context.js --playoffs 14,15,16
```

Node 18+, no dependencies. Reads:

- [ESPN FPI](https://www.espn.com/nfl/fpi) — Football Power Index, offensive /
  defensive / special-teams EPA
- [ESPN schedule grid](https://www.espn.com/nfl/schedulegrid) — all 18 weeks

and writes per team: FPI and rank, EPA splits, bye week, the full schedule, and
strength of schedule for both the full season and the fantasy playoff weeks
(mean opponent FPI; rank 1 = easiest).

```
Rank Team  FPI    Bye  SoS(season)  SoS(playoffs)
  1 LAR    5.6   11     0.81 (#31)      1.83 (#26)
  2 BUF      4    7    -0.08 (#12)      -1.1 (#10)
  3 BAL    3.7   13     -0.61 (#5)       -1.6 (#6)
```

This is static preseason data with no dependency on a draft room, so run it
whenever — ideally the morning of, since FPI moves through the preseason.

**It validates itself.** 272 games, exactly one bye per team, and every matchup
reciprocated with opposite home/away. A silent mis-parse is the real risk with
scraped data, so the script fails loudly instead of emitting a half-built table.

One quirk worth knowing: ESPN serves a JavaScript bot-challenge page to clients
claiming to be Chrome, and the real HTML to anything that identifies honestly as a
script. The script therefore sends its own user-agent. Do not "fix" it by pasting
in a browser user-agent — that is what breaks it.

## Queue manager

`queue-manager.user.js` (Tampermonkey) keeps the five best available players in
your Yahoo queue. **It never drafts.** When your turn arrives it goes silent and
hands the draft back to you — the queue is the safety net, because Yahoo drafts
the top of your queue if your clock expires.

Set `CFG.SLOT` and `CFG.TEAMS`, leave `DRY_RUN: true` for a full mock, then go live.

How it works:

- **Reads the player pool once**, at draft start — top 75 QB and TE, top 300
  WR/RB/Flex, all kickers and defenses, with NFL team, projected points, ADP and
  bye. None of that changes during a draft, so there is no reason to read it twice.
- **Tracks availability from the picks feed**, not by rescanning the player table.
  Each pick just removes a name from the pool.
- **Refills whenever the queue drops below five**, which happens exactly when one
  of your queued players is drafted by anyone.
- **Does nothing during your turn.** No clicks, no queue edits, no tab switching.

Every player row carries `.ys-addqueue[data-id]` — Yahoo's own player id, and the
only stable key in the room. Names are abbreviated to a first initial and collide
(`B. Robinson` is two different running backs), so nothing keys on them.

## How it values a player

```
raw   = projected points − best projection at that position still expected at your next turn
value = raw × 1.0   fills an empty starting slot
        raw × 0.9   fills flex
        raw × 0.2   bench only
```

Attrition before your next turn is estimated from ADP over the snake gap. The
result handles unusual scoring on its own: a position where every startable player
projects about the same is correctly valued near zero, however large the raw
numbers look.

## License

MIT
