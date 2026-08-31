# Draft strategy — Lord of Lifers et al

**This file is the input.** Edit it and the assistant follows it. Everything below
the "Locked facts" section is yours to rewrite; the assistant treats your wording
as authoritative and will tell you when your instructions conflict with the data
rather than silently overriding either one.

Last derived from Yahoo projections pulled 2026-08-27.

---

## Locked facts (verified from Yahoo, do not edit by hand)

| | |
| --- | --- |
| League | Lord of Lifers et al (ID# 813836) |
| Team | Purdy Good |
| Teams | 12 |
| Draft type | **Offline** — no Yahoo draft room, commissioner enters picks after |
| Rounds | 14 |
| Draft slot | 3 |
| Your picks | 3, 22, 27, 46, 51, 70, 75, 94, 99, 118, 123, 142, 147, 166 |
| Starting slots | QB, WR, WR, RB, RB, TE, W/R/T, K, DEF |
| Bench | 5 |

Scoring that differs from Yahoo default:

| Category | This league | Yahoo default |
| --- | --- | --- |
| Completions | **0.5** | 0 |
| Passing TD | **6** | 4 |
| Interceptions | **−2** | −1 |
| Receptions | **1 (full PPR)** | 0.5 |
| Sack (DEF) | **2** | 1 |
| Return yards | 10 yds / point | 0 |

Refresh these by re-reading `https://football.fantasysports.yahoo.com/f1/813836/settings`.

---

## What the numbers said

Derived, not assumed — from Yahoo projections already scored under the rules above.
Treat as the default strategy unless you overrule it below.

**Quarterback is the flattest position on the board.** The 0.5-per-completion rule
inflates every quarterback into the 420–540 range, which makes them look like
first-round picks. It raises the floor as much as the ceiling:

```
QB1 536 · QB6 492 · QB12 472 · QB18 461    ←  75 pts across 18 QBs
RB1 330 · RB6 262 · RB12 237 · RB18 213    ← 117 pts across 18 RBs
WR1 325 · WR6 269 · WR12 237 · WR18 223    ← 102 pts across 18 WRs
TE1 236 · TE6 176 · TE12 151 · TE18 139    ←  97 pts across 18 TEs
```

Josh Allen is worth ~66 points over a waiver-wire streamer — about four points a
week — at a third-round price. If the room drafts quarterbacks early because the
raw totals look enormous, that is value falling to slot 3.

**The quarterback window is pick 75.** Dak Prescott projected 515 (QB3 in this
scoring) at Yahoo rank 82, so he leaves the board between your picks at 75 and 94.
Take him at 75 or not at all. Fallback: Jared Goff, rank 120, available at 118.

**Tight end is the opposite — real scarcity at the top.** McBride and Bowers are
genuine edges that default rankings underrate for this league.

**Rounds 1–5 are the draft.** After round 5 nothing beats replacement by more than
about 10 points. Later rounds are depth and lottery tickets.

---

## Your strategy

> Rewrite this section. What is here now is the assistant's derived default.

- Take the best value available in rounds 1–3; do not reach for positional need.
- Do not draft a quarterback before round 7. Target Prescott at pick 75.
- Kicker and defense in the last two rounds only.
- Prefer a tight end early only if McBride or Bowers is there at pick 22.

### Must draft

_(none specified)_

### Never draft

_(none specified)_

### Risk posture

Balanced. Prefer a proven floor in rounds 1–3, accept upside bets from round 6 on.

---

## Standing cautions

**Verify large projection-vs-rank gaps before spending a pick.** Rotowire assigns
full workloads to backups who have not won the job. Flagged in the 2026 data:
Jadarian Price (proj 262, rank 62), Rashid Shaheed (proj 237, rank 135), Kenny
Gainwell (proj 217, rank 115), Parker Washington (proj 234, rank 57). Fine as late
darts, bad as round-4 picks.

**Week 14 clustering.** The derived board put McBride, Love, Turpin, Aubrey and
Prescott all on bye in week 14 — the last week before playoffs open in week 15.
Break the cluster at round 3 or round 11.

---

## Running the draft

The league drafts **offline**, so no automation applies on draft night and the
Yahoo player pool never updates during it. The assistant tracks the board from what
you tell it: say each pick as it happens and ask for your recommendation when
you're up.

Refresh the projections the morning of with `extract-board.js` — preseason
injuries move these numbers.
