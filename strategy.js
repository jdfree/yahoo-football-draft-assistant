/**
 * Draft strategy — valuation, opponent projection, and queue planning.
 *
 * This file contains the ALGORITHM and nothing else. It never touches the DOM,
 * the draft room, or any global: everything it needs arrives as a `ctx` snapshot
 * and a `cfg` object, and everything it decides comes back as a return value.
 * `queue-manager.user.js` owns all interaction with Yahoo and is free to change
 * without this file caring; this file can be replaced wholesale without the
 * manager caring.
 *
 * ── Swapping in your own ────────────────────────────────────────────────────
 * Define `window.YS_STRATEGY` before the manager loads and it will be used in
 * place of this one. Implement the four methods below; anything else here is
 * private. The manager checks the shape at load and refuses a partial strategy
 * rather than failing halfway through a draft.
 *
 *   name       string, for the log line.
 *
 *   baselines(players, cfg) -> { starter: {POS: n}, reserve: {POS: n} }
 *       League-shape bars, computed once from a snapshot of every player and
 *       never recomputed. Used only to seed the opponent model.
 *
 *   project(ctx, cfg, fromPick, toPick) -> Promise<{ target, gone, expected, simulated }>
 *       Simulate every pick between fromPick and toPick, skipping our own.
 *       `expected` is a ladder of survivors per position; its head is that
 *       position's floor. May be async; yield if it runs long.
 *
 *   rank(ctx, cfg, extra) -> [player]
 *       Every available player, best first, each annotated with at least
 *       { val, sortVal, role }. `extra` holds players already planned this pass
 *       so roles account for them. `val` is what the user sees.
 *
 *   plan(ctx, cfg, n, seed) -> [player]
 *       The queue as an ORDERED SEQUENCE of at most n players. Yahoo consumes it
 *       top-down, so each entry should be chosen as if those above it are gone.
 *
 * ── The ctx snapshot ────────────────────────────────────────────────────────
 * Built fresh by the manager for each call. Read it; never mutate it.
 *
 *   pool            Map id -> player {id,name,pos,team,proj,adp,bye}
 *   taken           Set of "NAME|POS" already drafted by anyone
 *   roster          [player] we currently hold
 *   rosterSize      number of roster spots in this league
 *   queued          [player] the live queue, valued as if not queued (lazy)
 *   queue           [player] the live queue as stored
 *   floors          Map targetPick -> { POS: [player] }   past projections
 *   proj            latest projection meta, or null
 *   baseline        { POS: n } starter bars   (from baselines())
 *   reserveBaseline { POS: n } reserve bars
 *   teamRosters     { drafterName: [player] } real rosters from the picks feed
 *   slotNames       { slotNumber: drafterName }
 *   vetoed          Set of "NAME|POS" the human pulled out repeatedly
 *   pickNo          current overall pick
 *   round           current round
 *   backToBack      true when our next two picks are consecutive
 *   teamContext     window.YS_TEAM_CONTEXT, or undefined
 *
 * Config keys are documented in CONFIG.md. Factor labels (V6, O15, Q6) refer to
 * ALGORITHM.md.
 */
(function (factory) {
  const api = factory();
  // globalThis, not window: this file must be loadable in plain Node so it can be
  // tested without a draft room. `typeof window` alone would be enough to fail
  // that test, since the harness traps the name.
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.YS_DEFAULT_STRATEGY = api;
})(function () {
  'use strict';

  const FLEX_POS = ['RB', 'WR', 'TE'];
  const ROLE_TIER = { 'must-fill': 0, starter: 1, flex: 1, reserve: 2 };

  /** Players are keyed by name+position everywhere. */
  const key = (name, pos) => `${name.replace(/\s+/g, ' ').trim().toUpperCase()}|${pos}`;

  /** Which slot picks at a given overall pick, in a snake. */
  function slotOfPick(cfg, overall) {
    const T = cfg.TEAMS;
    const round = Math.ceil(overall / T);
    const idx = (overall - 1) % T;
    return (round % 2 === 1) ? idx + 1 : T - idx;
  }

  /**
   * League-shape bars, one pair per position.
   *
   * STARTER — the Nth-best where N = TEAMS x starting slots. No flex factor: the
   * flex is modelled by the reserve bar rather than by inflating this one.
   *
   * RESERVE — how deep a team plausibly goes for a backup:
   *   K, DEF   no reserve at all, so the same bar as the starter
   *   QB, TE   one reserve
   *   RB, WR   one reserve PER STARTER, since that is where depth is carried
   *
   * Computed from a snapshot of every player, taken once. Recomputing against a
   * depleting pool walks the bars downward as the best players leave, which
   * measures the wrong thing.
   */
  function baselines(players, cfg) {
    const byPos = {};
    for (const p of players) (byPos[p.pos] = byPos[p.pos] || []).push(p.proj);
    const starter = {}, reserve = {};
    for (const [pos, slots] of Object.entries(cfg.STARTERS)) {
      const list = (byPos[pos] || []).sort((a, b) => b - a);
      if (!list.length) continue;
      const rank = (n) => list[Math.min(Math.round(n), list.length) - 1];
      starter[pos] = rank(cfg.TEAMS * slots);
      const reserves = (pos === 'K' || pos === 'DEF') ? 0
        : (pos === 'RB' || pos === 'WR') ? slots
        : 1;
      reserve[pos] = rank(cfg.TEAMS * (slots + reserves));
    }
    return { starter, reserve };
  }

  /**
   * What one team would take, given its roster and who is left. Models a rational
   * drafter: fill starting slots first by surplus over a replacement starter, then
   * draft for depth with RB/WR weighted up.
   */
  function projectedChoice(ctx, cfg, roster, pool, pickNo, base, reserveBase, bias) {
    const held = (pos) => roster.filter((r) => r.pos === pos).length;

    // One bar for every flex-eligible backup: the highest of the three reserve
    // bars, since a bench RB, WR or TE all compete for the same flex spot.
    let flexReserveBar = null;
    for (const q of FLEX_POS) {
      const v = reserveBase[q];
      if (v != null && (flexReserveBar === null || v > flexReserveBar)) flexReserveBar = v;
    }

    // O15 — how many of a position a team will ever carry. Nobody rosters three
    // quarterbacks or a second kicker, and without this the model spent whole
    // rounds stacking one position. A roster that already exceeds a limit through
    // real picks simply takes nothing more there.
    const limit = (pos) => cfg.SIM_ROSTER_LIMITS[pos] ?? (cfg.CAPS[pos] ?? 99);

    // A team will not take a third player at one position sharing a bye week.
    const byeBlocked = (p) => p.bye != null &&
      roster.filter((r) => r.pos === p.pos && r.bye === p.bye).length >= 2;

    // O16 — opponents do not take a kicker or defense until the closing rounds,
    // whatever the arithmetic says. Against the static baseline the best defense
    // scores about +20 and the best kicker about +9, which beats a mid-round back
    // at +5, so without this the model drafted eight defenses inside picks 45-98.
    // The surplus is real; the behaviour is not. Nobody spends a fifth-round pick
    // on a defense, and a model of opponents has to model what they do.
    const roundOfPick = Math.ceil(pickNo / cfg.TEAMS);
    const kdefAllowed = roundOfPick > ctx.rosterSize - cfg.SIM_KDEF_LAST_ROUNDS;

    let best = null, bestScore = -Infinity;
    for (const p of pool) {
      if (byeBlocked(p)) continue;
      if (held(p.pos) >= limit(p.pos)) continue;
      if (!kdefAllowed && (p.pos === 'K' || p.pos === 'DEF')) continue;

      // Measured against the bar for the slot this pick would fill, and weighted
      // by whether it fills a starting slot at all. No positional multipliers of
      // any kind: the difference between positions lives entirely in how deep
      // their two bars sit.
      const startingHere = held(p.pos) < (cfg.STARTERS[p.pos] || 0);
      // A BACKUP at RB, WR or TE is measured against the FLEX reserve bar — the
      // highest of the three — because all three compete for the same flex spot.
      // The same rule as V14 on our side, and for the same reason: measuring each
      // against his own position's reserve bar credits whichever position has been
      // picked over hardest. With reserve bars of RB 72.84, WR 102.96 and TE 84.56,
      // a mediocre tight end scored against 84.56 and looked worth taking; against
      // the flex bar of 102.96 he does not.
      const bar = startingHere
        ? (base[p.pos] ?? p.proj)
        : (flexReserveBar !== null && FLEX_POS.includes(p.pos)
            ? flexReserveBar
            : (reserveBase[p.pos] ?? base[p.pos] ?? p.proj));
      const weight = startingHere ? cfg.WEIGHT_STARTER : cfg.WEIGHT_RESERVE;
      const score = (p.proj - bar) * weight + (bias ? bias(p.pos) : 0);

      // Ties go to running back.
      if (score > bestScore || (score === bestScore && p.pos === 'RB' && best && best.pos !== 'RB')) {
        best = p; bestScore = score;
      }
    }
    return best;
  }

  async function projectAvailability(ctx, cfg, currentPick, targetPick) {
    if (!ctx.baseline) return null;
    const target = targetPick;

    /**
     * The yardstick opponents are measured against, resolved ONCE here and passed
     * down — never read from state while the simulation runs.
     *
     * The first projection has nothing to go on and uses the static worst-starter
     * baseline (S4). Every projection after that uses the floors from the most
     * recent COMPLETED projection instead, so the bar tracks the board rather than
     * staying pinned to preseason. That is what the late rounds were missing: once
     * every remaining player sits far below a fixed baseline, every score collapses
     * onto the +1 floor and the tie-break decides everything.
     *
     * Reference integrity: this snapshot is taken before a single pick is
     * simulated, and the floors this run produces are not written to ctx.floors
     * until it has returned. A projection can therefore never read itself.
     */
    const base = ctx.baseline;
    const reserveBase = ctx.reserveBaseline || {};

    /**
     * Per-team positional bias — the model's only source of heterogeneity.
     *
     * Every simulated team evaluates identically, so when a position becomes the
     * best-scoring open slot it becomes so for ALL of them at once. That produces
     * synchronised runs: 14 quarterbacks forecast across a 42-pick window (every
     * team taking one in the same stretch, against 2 actually drafted), and
     * earlier 17 tight ends and 24 running backs. Real managers differ, and the
     * runs they create are staggered.
     *
     * Each team gets a fixed offset per position for the whole run, scaled to the
     * gap between that position's starter and reserve bars — the natural measure
     * of what a position is worth — so the jitter means the same thing at QB,
     * where the gap is 71 points, as at DEF, where it is 14.
     *
     * Fixed for the run, not per pick: a manager who reaches for tight ends does
     * so consistently. It also keeps a single projection self-consistent.
     */
    const bias = {};
    const teamBias = (who, pos) => {
      let t = bias[who];
      if (!t) {
        t = bias[who] = {};
        for (const q of Object.keys(cfg.STARTERS)) {
          const spread = Math.abs((base[q] ?? 0) - (reserveBase[q] ?? base[q] ?? 0));
          t[q] = cfg.SIM_JITTER * spread * (Math.random() * 2 - 1);
        }
      }
      return t[pos] || 0;
    };
    const mine = new Set(ctx.roster.map((r) => key(r.name, r.pos)));

    // Everyone still on the board, best first.
    const pool = [...ctx.pool.values()]
      .filter((p) => !ctx.taken.has(key(p.name, p.pos)) && !mine.has(key(p.name, p.pos)))
      .sort((a, b) => b.proj - a.proj);

    // ACTUAL rosters and PROJECTED rosters are kept strictly apart. The
    // simulation adds imaginary picks, so it works on copies; ctx.teamRosters
    // only ever changes when a real pick is observed in the feed. Every rebuild
    // re-forks from the current actual rosters, so a projection is never seeded
    // with the previous projection's guesses.
    const projectedRosters = {};
    for (const [name, list] of Object.entries(ctx.teamRosters || {})) {
      projectedRosters[name] = list.map((p) => ({ ...p }));
    }

    const gone = new Set();
    let simulated = 0;
    for (let p = currentPick; p < target; p++) {
      const slot = slotOfPick(cfg, p);
      if (slot === cfg.SLOT) continue;                 // our own picks are not simulated
      const who = (ctx.slotNames || {})[slot] || `slot${slot}`;
      const rost = projectedRosters[who] || (projectedRosters[who] = []);
      const choice = projectedChoice(ctx, cfg, rost, pool.filter((x) => !gone.has(x.id)), p, base,
                                     reserveBase, (pos) => teamBias(who, pos));
      if (!choice) continue;
      gone.add(choice.id);
      rost.push(choice);
      simulated++;
      await Promise.resolve();      // yield between picks; see ensureProjection
    }

    const expected = {};
    for (const p of pool) {
      if (gone.has(p.id)) continue;
      if (expected[p.pos] === undefined) expected[p.pos] = [];
      if (expected[p.pos].length < 12) expected[p.pos].push(p);  // a ladder, deep enough for a full queue
    }
    return { target, gone, expected, simulated };
  }

  /** Per-team playoff modifier from team-context.gen.js; 1.0 when absent. */
  function playoffModifier(ctx, cfg, team) {
    const tc = ctx.teamContext;
    if (!ctx || !cfg.PLAYOFF_SWING) return 1;
    const m = ctx.teams?.[(team || '').toUpperCase()]?.mod;
    if (!Number.isFinite(m)) return 1;
    // Rescale if the generated file used a different swing than configured here.
    return ctx.swing === cfg.PLAYOFF_SWING ? m
      : 1 + (m - 1) * (cfg.PLAYOFF_SWING / (ctx.swing || cfg.PLAYOFF_SWING));
  }

  /**
   * Bye penalty. Counts how many players you already hold at this position who
   * share this bye week. Once that reaches the number of starting slots at the
   * position, adding another means a week with nobody to start there.
   */
  /**
   * Reduction for already holding a teammate. Applied to the PROJECTION rather
   * than the final value, so it flows through the value-over-replacement maths
   * exactly as a genuinely lower-projected player would.
   *
   * Kickers and defenses are exempt by design.
   */
  function sameTeamMultiplier(cfg, player, have) {
    if (!cfg.SAME_TEAM_PENALTY || !player.team) return 1;
    if (player.pos === 'K' || player.pos === 'DEF') return 1;
    const teammates = have.filter((h) => h.team && h.team === player.team
      && h.pos !== 'K' && h.pos !== 'DEF').length;
    // Compounds: a third player from the same team is penalised more than the
    // second. This can push a player below replacement, which is intended.
    return Math.pow(1 - cfg.SAME_TEAM_PENALTY, teammates);
  }

  function byeMultiplier(cfg, player, have) {
    if (!cfg.BYE_FACTOR || !player.bye) return 1;
    const clash = have.filter((h) => h.pos === player.pos && h.bye === player.bye).length;
    const slots = Math.max(1, cfg.STARTERS[player.pos] || 1);
    return 1 - cfg.BYE_FACTOR * Math.min(1, clash / slots);
  }

  /**
   * `extra` holds players already planned into this refill pass. Without threading
   * them through, every slot in a five-deep queue is scored against the SAME
   * roster — which queued five kickers for a one-kicker roster slot.
   */
    /**
   * The best player still on the board at each position, right now.
   *
   * A floor claims "this good a player will still be there later". The pool only
   * ever shrinks, so that claim is refuted the moment the board falls below it —
   * and it does: a projection made at pick 74 promised a 173.46 receiver at pick
   * 126, while the best on the board at pick 111 was already 139.09. Between our
   * turns at slot 14 there are 27 picks, so a stale floor can stand for fifty.
   */
  function bestAvailableNow(ctx) {
    const mine = new Set(ctx.roster.map((r) => key(r.name, r.pos)));
    const best = {};
    for (const p of ctx.pool.values()) {
      const k = key(p.name, p.pos);
      if (ctx.taken.has(k) || mine.has(k)) continue;
      if (best[p.pos] === undefined || p.proj > best[p.pos]) best[p.pos] = p.proj;
    }
    return best;
  }

  function rankAvailable(ctx, cfg, extra) {
    const have = ctx.roster.concat(extra || []);
    const planned = new Set((extra || []).map((e) => e.id));
    const size = ctx.rosterSize;
    const rd = ctx.round;
    const count = (p) => have.filter((x) => x.pos === p).length;
    const mine = new Set(have.map((h) => key(h.name, h.pos)));

    // Players already in the queue STAY in the ranking. Excluding them boxed us
    // out of our own best options: planQueue could never name a player we had
    // queued, so the ideal plan and the live queue shared nothing, every entry
    // looked stale to reconciliation, and the whole queue was torn down and
    // rebuilt every cycle. Callers that add to the queue skip what is already
    // there themselves.
    const avail = [...ctx.pool.values()]
      .filter((p) => !ctx.taken.has(key(p.name, p.pos)))
      .filter((p) => !mine.has(key(p.name, p.pos)))
      .filter((p) => !planned.has(p.id))
      .filter((p) => !ctx.vetoed.has(key(p.name, p.pos)));

    // A required position we can no longer defer overrides everything.
    const missing = Object.entries(cfg.STARTERS)
      .flatMap(([p, k]) => Array(Math.max(0, k - count(p))).fill(p));
    const picksLeft = size - have.length;
    if (missing.length >= picksLeft && picksLeft > 0) {
      return avail.filter((p) => p.pos === missing[0])
        .sort((a, b) => b.proj - a.proj)
        // Return the SAME shape as a normal ranking: a partial object here threw
        // inside the overlay ("reading 'toFixed' of undefined"), and because the
        // tick renders the overlay directly it surfaced as an opaque tick ERROR.
        .map((p) => ({ ...p, val: Infinity, sortVal: Infinity, raw: p.proj,
                       playoffDelta: 0, playoffMod: 1, byeMod: 1, teamMod: 1,
                       depthMult: 1, role: 'must-fill', tier: ROLE_TIER['must-fill'],
                       why: `must-fill ${missing[0]}` }));
    }

    const byPos = {};
    for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
      byPos[pos] = avail.filter((p) => p.pos === pos).sort((a, b) => b.proj - a.proj);
    }

    // Where we are in the draft, for turning ADP into a survival probability.
    const currentPick = ctx.pickNo;

    // Predict WHO goes by ADP, and drop exactly those players. The previous model
    // counted departures by ADP and then removed that many from the TOP of the
    // projection list, as though the players taken were the highest-projected —
    // they are not. That inflated replacement level at any position holding a
    // projection/ADP outlier, making everyone there look less valuable than they
    // were. Each signal is now used for what it actually measures.
    // Most of the pool carries no ADP (the column shows "–"), and storing those
    // as 999 made them immortal — never among the lowest ADP, so never predicted
    // gone. Give them an effective ADP just past the real ones, ordered by
    // projection, so the good ones can still be taken.
    const withAdp = avail.filter((p) => p.adp < 900).sort((a, b) => a.adp - b.adp);
    const noAdp = avail.filter((p) => p.adp >= 900).sort((a, b) => b.proj - a.proj);
    const lastReal = withAdp.length ? withAdp[withAdp.length - 1].adp : currentPick;
    const effAdp = new Map();
    withAdp.forEach((p) => effAdp.set(p.id, p.adp));
    noAdp.forEach((p, i) => effAdp.set(p.id, lastReal + 1 + i));

    // The current projection, whatever turn it was computed for. It used to be
    // discarded unless its round matched the room's — a leftover from when it was
    // recomputed per round. Now that it is refreshed per TURN, that test went false
    // the moment the room advanced a round, and every position silently fell back
    // to the ADP model: kickers priced against the end of the draft came out at
    // +71.7 and led the queue.
    const projected = ctx.proj || null;

    // Our final pick of the draft, used for kickers and defenses.

    /**
     * Replacement level differs by position.
     *
     * Skill positions: what you could still get at your NEXT turn.
     *
     * Kickers and defenses: NOT the next turn. Nobody drafts a second kicker, so
     * the real choice is "take one now" versus "take one in the final round" —
     * there is no meaningful middle. Replacement is therefore the best one still
     * on the board once every other team has taken theirs, i.e. TEAMS-1 deep.
     */
    /**
     * What you would get INSTEAD of this player if you passed on him.
     *
     * `exceptId` matters: replacement was previously computed once per position
     * and reused, so the best available player at a position was his own
     * replacement and his surplus came out as zero — the model literally
     * concluded "if I pass on the top receiver, the top receiver will still be
     * there". A player is never his own fallback.
     */
    /**
     * The EXPECTED best player still available at this position when we come back
     * to it — a probability-weighted blend, not the first name that clears a
     * cutoff. Walking the list by projection, each player contributes his
     * projection times the chance he is the best one left: he survives and
     * everyone better than him does not.
     *
     * `exceptId` matters: a player is never his own fallback. Reusing one
     * replacement per position made the best available player score zero surplus.
     */

    // Computed once per ranking: the best player still on the board at each
    // position. V13 clamps every bar to it, so no bar can promise more than the
    // board holds.
    const liveBest = bestAvailableNow(ctx);

    /** Floors from the deepest horizon we have projected, for bench valuation. */
    const deepestFloors = () => {
      let best = null, bestAt = -1;
      for (const [at, byPosn] of ctx.floors) if (at > bestAt) { bestAt = at; best = byPosn; }
      return best;
    };

    /**
     * The bar a candidate must clear, which depends on what he would be.
     *
     * A STARTER is measured against the higher of the near floor and the
     * worst-starter baseline. The floor alone is not enough: late on, the best
     * player left at a position can be well below starting calibre, and measuring
     * against him would make a replacement-level body look like an upgrade. The
     * baseline is the floor beneath the floor.
     *
     * A BENCH player is measured against the deepest horizon we have projected.
     * He is not competing for this pick so much as for a late one, and the honest
     * question is what will still be there at the far end of the draft.
     */
    const replacement = (pos, exceptId, role) => {
      const l = byPos[pos].filter((p) => p.id !== exceptId);   // sorted by projection
      if (!l.length) return 0;
      // Every position is treated alike: the baseline and the projected floors
      // apply to kickers and defenses exactly as they do to running backs. They
      // used to be measured against the END of the draft instead, on the argument
      // that the real choice is "one now versus one with my last pick" — but that
      // put them on a different scale to everything else and made their surplus
      // impossible to compare with a skill player's.
      if (role === 'reserve') {
        const deep = deepestFloors();
        if (deep) {
          /**
           * V14 — a bench RB, WR or TE is measured against the FLEX floor: the
           * best flex-eligible player expected to survive, whichever position he
           * plays. All three end up competing for the same flex spot, so the
           * alternative to taking one is not "another back" but "the best of the
           * three".
           *
           * Measuring each against his own position's floor let a bench back with
           * a collapsed RB floor (101.1) show +37.5 while a receiver filling an
           * open STARTING slot showed far less, and at 0.2 x 2 = 0.4 that was
           * enough to put reserves above a starter whose raw points were higher.
           * Against the flex floor of 135.0 the same back is worth +3.6.
           *
           * Starting slots keep their own position's floor — a starting WR slot
           * can only be filled by a receiver, so the flex bar does not apply.
           */
          const positions = FLEX_POS.includes(pos) ? FLEX_POS : [pos];
          let bar = null;
          for (const q of positions) {
            const survivor = deep[q] && deep[q].find((p) => p.id !== exceptId);
            if (survivor && (bar === null || survivor.proj > bar)) bar = survivor.proj;
          }
          if (bar !== null) return bar;
        }
      }

      if (projected && projected.byPos[pos]) {
        // The BEST survivor, for every candidate — not a ladder indexed by how many
        // of this position we have already queued.
        //
        // We make ONE pick now. Passing on this position leaves us the best player
        // still there at the horizon, whoever we would otherwise have queued, so
        // that single figure is the true cost of forgoing the position this round.
        // A negative surplus is the point, not a defect: it says this player will
        // still be around later and the pick is better spent elsewhere. Indexing a
        // ladder made those numbers positive by measuring against a bar nobody
        // actually faces, which hid exactly that signal.
        // The floor alone, for every role. NOT max(floor, baseline).
        //
        // Surplus over the floor means "what I gain by taking him now instead of
        // waiting". Surplus over the worst-starter baseline means "how much better
        // than a replacement starter". Those are different quantities, and taking
        // the greater of the two silently switched between them, so the same number
        // meant different things at different moments — a receiver in round 13 read
        // -40.8 because the bar had quietly stopped being "what you'd get by
        // waiting" and become the baseline instead.
        //
        // The scarcity the baseline was added for is handled better by the
        // projection itself. If every team already holds a quarterback the
        // simulation takes none, so the floor is the current best quarterback,
        // self-exclusion leaves only a small surplus, and he is not queued. Once
        // teams start on backups the floor drops, the surplus rises, and because he
        // fills an empty starting slot he carries full starter weight — the urgency
        // appears on its own, from the actual board rather than a preseason
        // constant.
        //
        // The baseline is still computed, and still used as the opponent model's
        // positional yardstick, where our own horizons do not transfer.
        const survivor = projected.byPos[pos].find((p) => p.id !== exceptId);
        if (survivor) {
          // Never claim more will be there later than is there now.
          const now = liveBest[pos];
          return now === undefined ? survivor.proj : Math.min(survivor.proj, now);
        }
      }
      // Fallback for a position the simulation never reached — it holds no
      // survivors there, so assume nobody at it gets drafted and the best man left
      // is still the best man left. This replaces an ADP survival model that is no
      // longer reachable in normal play: floors are seeded before anything is
      // valued, so the branch above answers every real case.
      return l[0].proj;
    };

    const flexUsed = ['RB', 'WR', 'TE']
      .reduce((n, p) => n + Math.max(0, count(p) - cfg.STARTERS[p]), 0);

    // The cap is a hard exclusion. The late-round gate is NOT: it blocks
    // selection only, so gated players are still valued and the overlay can
    // explain them rather than showing a blank row.
    const legal = (p) => count(p.pos) < cfg.CAPS[p.pos];
    const isGated = (p) => cfg.LATE_ONLY.includes(p.pos) && rd < size - 1;

    /**
     * The bar for the FLEX slot is not the bar at the player's own position.
     *
     * A flex slot is one slot contested by every RB, WR and TE. If you pass on a
     * tight end for it, your alternative is not another tight end — it is the best
     * flex-eligible player on the board, whoever that is. Measuring a TE for flex
     * against the TE replacement level credits him for tight-end scarcity that was
     * already spent on the dedicated TE slot, and that scarcity bar is far lower
     * than RB's. Live consequence: with RB 2/2 and TE 1/1 filled, T. Warren (TE,
     * 162.4 proj) outranked D. Montgomery (RB, 185.2 proj) for the same flex slot.
     */
    const flexReplacement = (exceptId) =>
      Math.max(...FLEX_POS.map((pos) => replacement(pos, exceptId, 'flex')));

    return avail.filter(legal).map((p) => {
      let weight = cfg.WEIGHT_STARTER, role = 'starter';
      if (count(p.pos) >= cfg.STARTERS[p.pos]) {
        if (FLEX_POS.includes(p.pos) && flexUsed < cfg.FLEX) {
          weight = cfg.WEIGHT_FLEX; role = 'flex';
        } else {
          weight = cfg.WEIGHT_RESERVE; role = 'reserve';
        }
      }

      // Role decides which bar applies, so it must be settled first.
      const bar = role === 'flex' ? flexReplacement(p.id) : replacement(p.pos, p.id, role);

      // DISPLAYED value: the pure surplus, carrying no modifiers whatsoever.
      // Everything that shapes preference is applied below, to the sort key only,
      // so the number on screen always means one thing: points above what you
      // could get at this slot if you passed.
      const raw = p.proj - bar;

      const pm = playoffModifier(ctx, cfg, p.team);
      const bm = byeMultiplier(cfg, p, have);
      const teamMod = sameTeamMultiplier(cfg, p, have);

      // A bench RB or WR carries three times the weight of a bench player
      // elsewhere. Applied to the role weight, so 0.2 becomes 0.6 for them.
      const benchMult = (role === 'reserve' && (p.pos === 'RB' || p.pos === 'WR'))
        ? cfg.BENCH_RB_WR_MULTIPLIER : 1;
      const rankRaw = p.proj * teamMod - bar;
      const sortVal = rankRaw * weight * benchMult * bm * pm;
      const playoffDelta = raw * (pm - 1);

      return { ...p, raw: +raw.toFixed(2), val: +raw.toFixed(2),
               playoffDelta: +playoffDelta.toFixed(2),
               tier: ROLE_TIER[role] ?? 2,
               sortVal: +sortVal.toFixed(2), depthMult: benchMult, role,
               gated: isGated(p),
               playoffMod: +pm.toFixed(4), byeMod: +bm.toFixed(3), teamMod: +teamMod.toFixed(3),
               why: `${p.proj} - repl ${bar.toFixed(1)} = ${raw.toFixed(1)} shown;` +
                    ` rank x${weight}(${role}) x${pm.toFixed(3)}(po) x${bm.toFixed(2)}(bye)` +
                    (benchMult !== 1 ? ` x${benchMult}(bench RB/WR)` : '') };
    // Rank on VALUE, with role expressed as a weight rather than a hard tier.
    //
    // Tiering every starter above every bench player was too blunt in both
    // directions. It was added because the old x3 backup multiplier let backups
    // leapfrog genuine starters; but it then meant a defense worth +3.3, filling
    // the last empty starting slot, outranked a running back worth +80 who would
    // sit on the bench. No sensible drafter makes that trade.
    //
    // The weights already price the trade-off proportionally: at WEIGHT_RESERVE
    // 0.2 a bench player must be worth five times a starter's surplus to pass him,
    // so 80 x 0.2 = 16 beats 3.3 x 1.0, while a marginal bench player still loses
    // to a real starting need. must-fill keeps its Infinity and so still wins
    // outright when a roster slot has become mandatory.
    }).sort((a, b) => b.sortVal - a.sortVal);
  }

  /** Positions where we can only take one more before hitting the cap. */
  const isScarce = (cfg, pos, have) =>
    (cfg.CAPS[pos] || 0) - have.filter((h) => h.pos === pos).length === 1;


  /**
   * Build the queue.
   *
   * Slots are a SEQUENCE, not a ranked list: Yahoo consumes them top-down, so
   * each entry is scored as if the ones above it were already drafted. That alone
   * stops a five-kicker queue for a one-kicker roster slot.
   *
   * One exception. When our next pick is not back to back, the entry after a
   * scarce pick is a same-position backup rather than the next player in the
   * sequence — if the drafter ahead of us takes our only kicker, we want the next
   * kicker at the top, not a receiver.
   *
   * That backup is unsafe when we pick twice in a row, because autodraft would
   * take both and hand us two kickers. Spacing them further down does not help:
   * whatever sits between them can be sniped too. So when picks are back to back
   * the queue is a strict sequence, hard-capped at one kicker and one defense.
   */
  /**
   * How many queue slots one position may occupy. Keeping this below the queue
   * size guarantees the queue always offers a genuine alternative rather than
   * five variations on the same decision — if a run empties that position, the
   * rest of the queue is still useful.
   */
  const positionLimit = (cfg, pos) => {
    // Caps scale with the queue rather than sitting just under it. At
    // QUEUE_SIZE - 2 a single position could take 8 of 10 slots, which defeats
    // the point of the cap: the queue is supposed to keep offering a genuine
    // alternative when a run empties one position. Live it reached 6 of 8.
    //
    // Half the queue for skill positions, a quarter for K and DEF. Neither
    // depends on back-to-back picks: Q10 prevents a doubled position at the draft
    // click, by position, and collapsing the K/DEF cap on a pair only stripped
    // the fallback out of every turn-slot queue — leaving nothing behind a kicker
    // sniped between the rebuild and our clock.
    //
    // At QUEUE_SIZE 10 that is 5 skill and 2 K/DEF; at 8, 4 and 2.
    const share = (pos === 'K' || pos === 'DEF') ? 4 : 2;
    return Math.max(1, Math.floor(cfg.QUEUE_SIZE / share));
  };

  function planQueue(ctx, cfg, n, seed = null) {
    const b2b = ctx.backToBack;
    // Players ALREADY queued must count as provisional roster additions. Refilling
    // one slot at a time re-planned against the roster alone, so each pass added
    // another defense: a live queue reached DEF,K,DEF,DEF,K and autodraft put two
    // defenses on the roster before it was caught.
    const queued = (seed || ctx.queued).filter((p) => p && p.pos && p.pos !== '?');
    const chosen = [];

    // Roles are judged against the roster you ACTUALLY have, not the roster you
    // would have if the whole queue came true. Treating queued players as already
    // rostered filled the notional starting lineup, after which a kicker and a
    // defense still scored at full starter weight while every further RB and WR
    // dropped to bench weight — so a K and a DEF landed in the queue in round 1
    // with starting RB and TE unfilled and far better players available.
    //
    // Stacking is held off by the position limits below, which DO count the whole
    // queue; that is what the seeding was really protecting against.
    const posCount = {};
    for (const p of queued) posCount[p.pos] = (posCount[p.pos] || 0) + 1;

    while (chosen.length < n) {
      // rankAvailable(ctx, cfg, []) — NOT rankAvailable(chosen).
      //
      // rankAvailable derives roles from ctx.roster.concat(extra), so passing the
      // players chosen so far makes the plan fill its own notional lineup: after a
      // couple of backs and receivers are picked, every FURTHER back and receiver
      // is judged bench and multiplied by 0.2, while the still-empty kicker and
      // defense slots keep full starter weight. That is what put a kicker worth
      // +2.1 and a defense worth +6.1 into a round-3 queue ahead of a back worth
      // +42.9. Roles must reflect the roster we actually have.
      //
      // Dedup is handled by the id filter below and stacking by posCount, so
      // nothing is lost by not seeding.
      const ranked = rankAvailable(ctx, cfg, [])
        .filter((p) => !chosen.some((c) => c.id === p.id))
        .filter((p) => !p.gated)                       // late-round gate applies here
        .filter((p) => (posCount[p.pos] || 0) < positionLimit(cfg, p.pos));
      if (!ranked.length) break;
      const pick = ranked[0];
      chosen.push(pick);
      posCount[pick.pos] = (posCount[pick.pos] || 0) + 1;
      if (chosen.length === 1 && !queued.length && !b2b && isScarce(cfg, pick.pos, ctx.roster)) {
        const backup = rankAvailable(ctx, cfg, []).find((p) => p.pos === pick.pos && p.id !== pick.id);
        if (backup && chosen.length < n) chosen.push(backup);
      }
    }

    return chosen;
  }
  return {
    name: 'surplus',
    baselines,
    project: projectAvailability,
    rank: rankAvailable,
    plan: planQueue,
    // Optional. The floors strip clamps each projected floor to the live board
    // (V13) and needs the same numbers the ranking uses. Exposed so there is one
    // implementation rather than a copy in the manager; a custom strategy may
    // omit it and the strip will simply not clamp.
    bestAvailable: bestAvailableNow,
    // Optional. Q6's per-position queue cap. The manager also enforces it when
    // pruning, so it is exposed rather than duplicated; omit it and the manager
    // stops pruning on that rule.
    positionLimit,
  };
});
