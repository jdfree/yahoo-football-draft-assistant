// ==UserScript==
// @name         Yahoo Draft Queue Manager
// @namespace    jfree.fantasy
// @version      1.0
// @description  Keeps your Yahoo draft queue stocked with the best available players. You still make every pick.
// @match        https://football.fantasysports.yahoo.com/draftclient/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
//
// WHAT THIS DOES, AND DELIBERATELY DOES NOT DO
//
// It keeps the five best available players in your Yahoo queue. It never drafts.
// When your turn arrives it goes completely silent and hands the draft back to
// you — the queue is your safety net, because Yahoo autodrafts the top of the
// queue if your clock expires. (Verified live: an idle turn drafted the queue's
// top player and the badge dropped from 3 to 2.)
//
// Availability is tracked by watching the PICKS FEED, not by rescanning the
// player table. The pool is read once at the start; every subsequent pick just
// removes a name. Rescanning would be slower and would fight you for the UI.
//
// DOM contract below was mapped in live mock drafts. Yahoo documents none of it.
//
(function () {
  'use strict';

  const CFG = {
    DRY_RUN: true,        // log intentions without touching the queue

    // --- draft shape -------------------------------------------------------
    TEAMS: 12,
    SLOT: 1,              // <-- your ACTUAL slot; the waiting room can reassign it
    TICK_MS: 2000,
    STARTERS: { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 },
    FLEX: 1,              // W/R/T slots
    CAPS: { QB: 2, RB: 6, WR: 7, TE: 3, K: 1, DEF: 1 },
    // Top 100 per position. The table caps at 100 rows per view and does NOT
    // lazy-load past it, so a single deep 'Flex' pull is not possible.
    POOL: ['Quarterbacks', 'Running Backs', 'Wide Receivers', 'Tight Ends', 'Kickers', 'Team Defenses'],

    // --- 1. queue size -----------------------------------------------------
    QUEUE_SIZE: 8,

    // --- 2. starters vs reserves -------------------------------------------
    // How much a player is worth by the role he would fill. Raising RESERVE
    // relative to STARTER buys the best remaining player at a contested position
    // instead of plugging an empty starting slot with someone mediocre.
    //
    // A reserve is worth a fifth of a starter — EXCEPT at running back and
    // receiver, where a reserve counts twice as much as a reserve elsewhere (an
    // effective 0.4). Lowered from three, to prefer backs less.
    //
    // Bench depth genuinely matters at those positions: you start two of each plus
    // a flex and they miss time most often, whereas a backup quarterback behind an
    // established starter is worth almost nothing however large his nominal
    // surplus.
    //
    // The SAME knob drives O10 in the opponent simulation, so changing it moves
    // both our preference and the predicted attrition behind the floors. It used
    // to be ours alone, with the simulation on a separate projection boost; the
    // two mechanisms could drift apart and one of them was always the wrong one.
    //
    // This is what separates the cases seen live: a back worth +35.5 on the bench
    // scores 21.3 and beats a kicker worth +7.58 filling an empty slot, while a
    // quarterback worth +24 on the bench scores 4.8 and does not.
    WEIGHT_STARTER: 1.0,
    WEIGHT_FLEX: 0.9,
    WEIGHT_RESERVE: 0.2,
    BENCH_RB_WR_MULTIPLIER: 2,

    // O15 — how many of a position the simulation lets one team carry. Nobody
    // rosters three quarterbacks or a second kicker. RB and WR are left to CAPS.
    // TE is 1, not 2: drafters eschew a second tight end rather than roster a
    // replacement-level one. The arithmetic disagrees — against a reserve bar of
    // 84.56 a 120-point tight end scores +35 — and the model duly predicted 17
    // tight ends in 30 picks. Nobody drafts like that. QB keeps 2, where a genuine
    // backup market exists.
    //
    // QB was briefly dropped to 1 on the theory that a 14-QB forecast in round 9
    // had to be wrong. It wasn't: in a 14-team league the flex pool is picked thin
    // by then, and the second quarterback really is the rational pick. Leave it.
    SIM_ROSTER_LIMITS: { QB: 2, TE: 1, K: 1, DEF: 1 },


    // O16 — how many rounds from the end an opponent will consider a kicker or a
    // defense. Purely behavioural: their surplus over baseline is genuinely large
    // (a top defense scores about +20), but nobody drafts one in round five, and a
    // model of opponents must model what they do rather than what the arithmetic
    // recommends. Each team needs exactly one of each, so this wants to be a
    // little wider than two.
    SIM_KDEF_LAST_ROUNDS: 2,

    // How much simulated managers differ from one another, as a fraction of the
    // gap between a position's starter and reserve bars. Every team otherwise
    // evaluates identically, so a position that tips becomes best for all of them
    // at once and the model forecasts synchronised runs — 14 quarterbacks in a
    // 42-pick window against 2 actually drafted. Each team draws a fixed offset
    // per position for the run. 0 restores the old deterministic behaviour.
    SIM_JITTER: 0.15,

    // --- 3. fantasy playoffs ------------------------------------------------
    // PLAYOFF_SWING is the TOTAL spread between the easiest and hardest playoff
    // schedule in the league. At 0.10, two otherwise identical players differ by
    // 10%; teams in between scale linearly. Set 0 to ignore schedule entirely.
    // Per-team modifiers come from window.YS_TEAM_CONTEXT (team-context.gen.js).
    // Regenerate that file with matching weeks:
    //   node fetch-team-context.js --playoffs 15,16,17 --swing 0.10
    PLAYOFF_WEEKS: [15, 16, 17],
    PLAYOFF_SWING: 0.10,

    // --- overlay ------------------------------------------------------------
    // Read-only panel showing the live ranking and the health of the tracker.
    // pointer-events:none, so it can never intercept a click. Off by default.

    // The projected-floors strip across the bottom of the centre table. Every
    // valuation rests on these numbers, so they are worth having on screen.
    SHOW_FLOORS: true,
    // Distance from the right edge, used only if the roster panel cannot be
    // measured. Normally the overlay auto-positions just left of your roster.

    // --- 5. last-second pick ------------------------------------------------
    // Seconds left on YOUR clock at which the manager drafts the top of the queue
    // itself. 0 = never; let the clock expire and Yahoo take the queue top.
    //
    // Setting this above 0 is not just convenience: Yahoo switches your team into
    // autopick mode whenever a timer actually expires, and every later pick is
    // then made for you. Picking at 2 seconds means the timer never expires, so
    // that never triggers.
    AUTOPICK_AT_SECONDS: 0,

    // Seconds left on the SECOND of two back-to-back picks at which we step in and
    // take the best queued player at a different position from the first. Yahoo
    // drafts the top of the queue when a clock expires, and that top rarely moves
    // in the seconds between two consecutive picks — so a turn can spend both on
    // the same position. Fires whether or not AUTOPICK_AT_SECONDS is enabled.
    PAIR_SPLIT_AT_SECONDS: 1,

    // Positions barred until the last two rounds. EMPTY BY DEFAULT: holding
    // kickers and defenses to the end is convention, not arithmetic, and the model
    // already prices them honestly — their replacement is measured against the END
    // of the draft ("one now versus one with my last pick"), not the next couple of
    // rounds, so an early defense has to beat every skill player on surplus to be
    // queued at all. Letting the convention override that costs real value: in a
    // live draft the best defense was worth 16.74 in round 9, the gate held it to
    // round 14, and by then the best available was worth 6.34 — while the bench
    // players queued instead were worth about 2.
    //
    // Set to ['K', 'DEF'] to restore the conventional behaviour. Roster caps still
    // prevent a second kicker or defense either way.
    LATE_ONLY: [],

    // Rewrite the queue so its ORDER matches the ranking, not just its membership.
    //
    // ON. Yahoo's queue rows carry dnd-kit drag handles with a documented keyboard
    // protocol, so the queue is reordered by DRAGGING and no player is removed to
    // move him. That is what makes order compatible with a minimal delta; the
    // earlier remove-and-re-add approach turned a rebuild into "added 1, removed
    // 8, kept 0" and had to be switched off.
    //
    // It matters because Yahoo drafts the TOP of the queue when your clock expires.
    ENFORCE_QUEUE_ORDER: true,

    // How close to our turn the projection is run, in picks. Running it late means
    // it sees the picks that just happened, so a run on a position is priced in
    // rather than averaged away by a projection taken at the top of the round.
    PROJECT_AT_PICKS_AWAY: 3,

    // How many times you must pull the same player out of the queue before we stop
    // putting him back. One removal is ambiguous — a player can leave the queue
    // because he was drafted a moment before the feed caught up — so a single
    // removal is never treated as a verdict.
    VETO_AFTER: 3,

    // --- backup depth at RB/WR ----------------------------------------------


    // --- same-team bias -----------------------------------------------------
    // Percentage reduction applied to a player's projection when you already hold
    // someone from his NFL team. 0 disables it. 0.10 means a player from a team
    // you already own projects 10% lower for ranking purposes.
    //
    // Deliberately NOT applied to kickers or defenses: a defense's output is not
    // diminished by owning that team's running back.
    SAME_TEAM_PENALTY: 0,

    // --- 4. bye weeks -------------------------------------------------------
    // 0 ignores byes entirely. 1 means a player whose bye would leave a starting
    // slot empty is worth nothing. Scales with how badly the bye collides.
    BYE_FACTOR: 0.5,
  };

  // Loader overrides, so nobody has to edit this file to run it:
  //   window.YS_CONFIG = { SLOT: 4, TEAMS: 12 };
  // must be set BEFORE this script is evaluated.
  if (window.YS_CONFIG) Object.assign(CFG, window.YS_CONFIG);

  const LOG = [];
  const say = (m) => { LOG.push(`${new Date().toISOString().slice(11, 19)} ${m}`); console.log('[queue]', m); };
  window.__queueLog = LOG;

  // ---------------------------------------------------------------------------
  // Reading the room
  // ---------------------------------------------------------------------------

  /**
   * Identify the player table by `.ys-player[data-id]`, which is always present.
   * Do NOT use `.ys-addqueue`: during YOUR turn Yahoo swaps that queue-star cell
   * for a "Draft" button, so the table becomes invisible to us exactly when a
   * reload or pool read happens mid-turn — which left the pool empty and the whole
   * assistant inert.
   */
  const playerTable = () => [...document.querySelectorAll('table')]
    .find((t) => t.querySelector('.ys-player[data-id]'));

  /**
   * Column indexes must be resolved on EVERY read, never cached: the Quarterbacks
   * view shows Pass Yds where the Flex view shows Rec, so a stale index silently
   * reads a completely different number.
   */
  function columns() {
    const tbl = playerTable();
    if (!tbl) return null;
    const hs = [...tbl.querySelectorAll('thead th')].map((h) => h.innerText.replace(/\s+/g, ' ').trim());
    const ix = (re) => hs.findIndex((h) => re.test(h));
    const c = { proj: ix(/Proj\s*Pts/i), adp: ix(/^ADP$/i), bye: ix(/^Bye$/i) };
    return c.proj < 0 ? null : c;
  }

  /**
   * Parse a `.ys-player` element structurally. Its innerText is one field per line:
   *
   *   C. Hubbard      name
   *   Q               injury tag (optional)
   *   RB              position
   *   Car             NFL team
   *   Bye 5
   *
   * Position is matched as a WHOLE LINE. Substring matching on the concatenated
   * text is what made "K. Murray QB Min" parse as a kicker — the initial "K" hit
   * before the real position did, which wrecked his replacement level and put him
   * top of the queue. A standalone line is never an initial.
   */
  function parsePlayer(el) {
    const L = el.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
    const pi = L.findIndex((l) => /^(QB|RB|WR|TE|K|DEF)$/.test(l));
    if (pi < 0) return null;
    const next = L[pi + 1] || '';
    return {
      id: el.getAttribute('data-id'),
      name: L[0],
      pos: L[pi],
      team: /^Bye/i.test(next) ? '' : next.toUpperCase(),   // defenses carry no team
      bye: parseInt((L.find((l) => /^Bye/i.test(l)) || '').replace(/\D+/g, ''), 10) || null,
    };
  }

  function readRows() {
    const tbl = playerTable();
    const c = columns();
    if (!tbl || !c) return [];
    return [...tbl.querySelectorAll('tbody tr')].map((r) => {
      const el = r.querySelector('.ys-player[data-id]');
      if (!el) return null;
      const base = parsePlayer(el);
      if (!base) return null;
      const proj = parseFloat(r.children[c.proj]?.innerText);
      const adp = parseFloat(r.children[c.adp]?.innerText);
      if (!Number.isFinite(proj)) return null;
      return { ...base, proj, adp: Number.isFinite(adp) ? adp : 999, row: r };
    }).filter(Boolean);
  }

  /** Your roster panel is the one headed "YOUR TEAM (n/m)". Others show the team on the clock. */
  function myPanel() {
    return [...document.querySelectorAll('div,section,aside')]
      .filter((e) => /YOUR TEAM\s*\(/i.test(e.innerText || '') && (e.innerText || '').length < 600)
      .sort((a, b) => a.innerText.length - b.innerText.length)[0] || null;
  }
  function roster() {
    const p = myPanel();
    if (!p) return [];
    return [...p.querySelectorAll('.ys-player')].map((x) => {
      const t = x.innerText.replace(/\s+/g, ' ').trim();
      // Position is the token before team+Bye. A bare \bK\b matches the INITIAL
      // in "K. Walker III". Defenses render as "Lions DEF Bye 6" — no initial.
      const m = t.match(/\b(QB|RB|WR|TE|K|DEF)\b\s+(?:[A-Za-z]{2,3}\s+)?Bye\s*(\d+)?/);
      return m ? { name: t.split(/\s{2,}|\n/)[0], pos: m[1], bye: m[2] ? +m[2] : null } : null;
    }).filter(Boolean);
  }
  function rosterSize() {
    const m = myPanel()?.innerText.match(/YOUR TEAM\s*\(\d+\/(\d+)\)/i);
    return m ? +m[1] : 15;
  }

  /**
   * Queue size comes from the tab's badge ("Queue\n3"), which stays in the DOM no
   * matter which tab is open. Reading the queue's CONTENTS would require making
   * the Queue tab active, which would yank the UI away from you mid-draft.
   */
  /** The left panel's two tabs: "Queue <n>" and, to its right, "Picks". */
  function panelTabs() {
    const all = [...document.querySelectorAll('button,[role=tab]')];
    return {
      queue: all.find((b) => /^Queue\b/i.test((b.innerText || '').trim())),
      picks: all.find((b) => /^Picks$/i.test((b.innerText || '').trim())),
    };
  }
  /**
   * The centre tabs: Players | Board | Results | Standings | Ultra Draft Kit.
   * The player table only exists under "Players", so if the human is reading the
   * Board or Results our queue work silently finds nothing. Switch to Players for
   * the operation and put their tab back afterwards.
   */
  const CENTRE_TABS = ['Players', 'Board', 'Results', 'Standings', 'Ultra Draft Kit'];
  function centreTab(name) {
    return [...document.querySelectorAll('button,[role=tab],a')]
      .find((b) => (b.innerText || '').trim() === name);
  }
  function activeCentreTab() {
    for (const n of CENTRE_TABS) {
      const t = centreTab(n);
      if (t && (t.getAttribute('aria-selected') === 'true'
        || /border-bottom/.test(getComputedStyle(t).cssText || ''))) return n;
    }
    return playerTable() ? 'Players' : null;
  }
  async function withPlayersTab(fn) {
    const was = activeCentreTab();
    const needSwitch = was && was !== 'Players';
    if (needSwitch) {
      const t = centreTab('Players');
      if (t) {
        t.click();
        await waitForTable({ minRows: 10 });   // the table fully unmounts on other tabs
        say(`switched to Players (you were on ${was})`);
      }
    }
    try { return await fn(); }
    finally {
      if (needSwitch) {
        const back = centreTab(was);
        if (back) { back.click(); await sleep(400); say(`restored your ${was} tab`); }
      }
    }
  }

  const activeTab = () =>
    (document.querySelector('[aria-selected=true]')?.innerText || '').trim().split('\n')[0];

  function queueCount() {
    const tab = [...document.querySelectorAll('button,[role=tab]')]
      .find((b) => /^Queue\b/i.test((b.innerText || '').trim()));
    const m = tab && tab.innerText.match(/(\d+)/);
    return m ? +m[1] : 0;
  }

  /**
   * The picks feed is windowed — it held picks 20-89 at pick 90, not the whole
   * history. That is fine for incremental tracking at a 2s tick, but it means the
   * feed alone cannot reconstruct the start of the draft. The one-time pool read
   * covers that: whatever is in the table at arm time is what is still available.
   */
  /**
   * The header's "Last: NAME (POS)" line is always visible but only ever shows ONE
   * pick, and it turns over faster than any poll when several teams autodraft back
   * to back — picks slip through unrecorded. It is kept only as a cheap supplement;
   * the Picks panel is the real source.
   */
  function scanLastPick() {
    const m = document.body.innerText.replace(/\s+/g, ' ')
      .match(/Last:\s*([A-Za-z.'’\- ]+?)\s*\((QB|RB|WR|TE|K|DEF)\b/i);
    const rd = document.body.innerText.match(/Round\s*(\d+),\s*Pick\s*(\d+)/i);
    return m && rd ? [{ pick: +rd[2] - 1, name: m[1].trim(), pos: m[2].toUpperCase() }] : [];
  }

  /**
   * Read the Picks feed as structured rows: overall number, drafting team, player.
   *
   * Team names are read from their own element and compared with string equality —
   * never interpolated into a regex. Real rooms contain names like "I'm not Josh"
   * (a smart apostrophe), "tar he-AL", "Jean-Philippe", and a team called simply
   * "b"; any of those inside a pattern is a bug.
   */
  function scanPickRows() {
    const out = [];
    for (const el of document.querySelectorAll('.ys-player')) {
      if (/ADP:/.test(el.innerText)) continue;             // queue entry, not a pick
      const player = parsePlayer(el);
      if (!player) continue;

      // Climb to the row, then take its text lines: the pick number and the
      // drafter sit alongside the player block.
      let row = el;
      for (let i = 0; i < 4 && row.parentElement; i++) {
        row = row.parentElement;
        if (/^\s*\d{1,3}\s/.test(row.innerText || '')) break;
      }
      const lines = (row.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean);
      const numIdx = lines.findIndex((l) => /^\d{1,3}$/.test(l));
      if (numIdx < 0) continue;
      const overall = +lines[numIdx];

      // Rows are laid out [number, drafter, player, position, team, bye], so the
      // drafter is simply the next line. Do NOT filter by content: a team named
      // "K" or "DEF" would be rejected as a position and the NFL team picked up
      // instead. One room had a team called simply "b". Position in the row is
      // authoritative; only fall through if that line is missing entirely.
      let drafter = lines[numIdx + 1];
      if (!drafter || drafter === player.name) {
        drafter = lines.slice(numIdx + 1)
          .find((l) => l && l !== player.name && !/^Bye\b/.test(l));
      }
      out.push({ overall, drafter: drafter || `slot${slotOfPick(overall)}`, player });
    }
    return out;
  }

  /** Fold the feed into per-team rosters and the slot-to-name map. */
  function recordPicks() {
    for (const { overall, drafter, player } of scanPickRows()) {
      if (state.seenPickNos.has(overall)) continue;
      state.seenPickNos.add(overall);
      const full = state.pool.get(player.id)
        || [...state.pool.values()].find((x) => x.name === player.name && x.pos === player.pos);
      (state.teamRosters[drafter] = state.teamRosters[drafter] || [])
        .push(Object.assign({}, player, full ? { proj: full.proj } : {}));
      state.pickDrafter[overall] = drafter;       // raw, independent of league size
      state.pickPos[overall] = player.pos;        // for scoring predicted attrition
      state.slotNames[slotOfPick(overall)] = drafter;
      state.taken.add(key(player.name, player.pos));
    }
  }

  function scanPicks() {
    const found = [];
    for (const el of document.querySelectorAll('.ys-player')) {
      if (/ADP:/.test(el.innerText)) continue;            // queue panel entry, not a pick
      let n = null;
      for (let p = el.parentElement, i = 0; p && i < 4; p = p.parentElement, i++) {
        const m = (p.innerText || '').match(/^\s*(\d{1,3})\s/);
        if (m) { n = +m[1]; break; }
      }
      if (n !== null) found.push({ pick: n, text: el.innerText.replace(/\s+/g, ' ').trim() });
    }
    return found;
  }

  /** Seconds left on the clock, from the mm:ss in the draft header. */
  /**
   * The pick clock, read from the element that contains ONLY a mm:ss string.
   * Scanning body text for the first /\d+:\d\d/ matched kickoff times like
   * "Sun 11:00 am" instead, so the countdown never appeared to reach zero and the
   * last-second autopick never fired.
   */
  /**
   * The pick clock. Yahoo renders it two different ways and this cost several
   * failed autopicks before it was spotted:
   *
   *   11 seconds or more -> "00:12"   (mm:ss)
   *   10 seconds or less -> "5"       (a bare integer, no colon, no padding)
   *
   * A regex requiring the colon returns null for the entire final ten seconds —
   * exactly the window the last-second pick needs. Accept both, and prefer the
   * mm:ss form when both are on screen.
   */
  function secondsLeft() {
    const found = [];
    for (const el of document.querySelectorAll('div,span,p,h1,h2,h3,b,strong')) {
      if (el.children.length) continue;                 // leaf nodes only
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.top > 200) continue; // the clock sits at the top
      const t = (el.textContent || '').trim();
      let secs = null;
      const mm = /^(\d{1,2}):(\d{2})$/.exec(t);
      if (mm) secs = (+mm[1]) * 60 + (+mm[2]);
      else if (/^\d{1,2}$/.test(t)) secs = +t;          // final ten seconds
      if (secs === null || secs > 20 * 60) continue;
      found.push({ secs, top: rect.top, colon: !!mm });
    }
    if (!found.length) return null;
    found.sort((a, b) => (b.colon - a.colon) || (a.top - b.top));
    return found[0].secs;
  }

  /**
   * Draft the top of our queue with the clock nearly expired. Only ever called
   * during your own turn, and only inside the final AUTOPICK_AT_SECONDS.
   */
  /**
   * Draft with the clock nearly expired. Prefers the top of our queue, but falls
   * back to the best available player if the queue model is empty — after a reload
   * mid-turn, or if Yahoo cleared the queue, having nothing to pick is strictly
   * worse than picking the top of the board.
   */
  /** Find a player's row in the table, searching for them if necessary. */
  async function findPlayerRow(pl) {
    const byId = () => pl.id
      ? document.querySelector(`.ys-player[data-id="${pl.id}"]`)?.closest('tr')
      : null;
    const byName = () => [...document.querySelectorAll('table tbody tr')].find((r) => {
      const el = r.querySelector('.ys-player');
      const q = el && parsePlayer(el);
      return q && q.name === pl.name && q.pos === pl.pos;
    });
    let row = byId() || byName();
    if (row) return row;
    // Not on screen: search for them, and give the table time to re-render.
    setSearch((pl.name || '').replace(/^[A-Z]\.\s*/, ''));
    for (let i = 0; i < 4 && !row; i++) {
      await sleep(500);
      row = byId() || byName();
    }
    return row;
  }

  /**
   * Draft with the clock nearly expired. Works down the queue and then the board,
   * because a single failed lookup must not cost the pick — the Draft button only
   * exists during our turn and only on a row that is actually rendered.
   */
  /**
   * The position we took with the FIRST pick of a back-to-back pair, or null if
   * this is not the second pick of one.
   *
   * Read from the picks feed rather than the roster: the roster panel is not in
   * draft order, so "the last player we added" is not reliably the one we just
   * took. The pick immediately before ours being ours is exactly what makes this
   * the second of a pair.
   */
  function pairFirstPosition() {
    // Detected from the ROSTER, not the header or the picks feed.
    //
    // Across back-to-back picks Yahoo keeps "your turn" continuous and the header
    // lags, so at the second pick it still read the first pick's number — making
    // "was the previous pick mine?" false every time. The picks feed is no help
    // either: the tick deliberately does not sync it during our own turn. The
    // roster panel, though, updates the moment a pick lands.
    //
    // So: snapshot our roster when the turn begins, and if it has since grown
    // while the turn is still running, we are on the second pick of a pair and the
    // position that grew is what we just took.
    if (!state.turnRosterCounts) return null;
    const now = {};
    for (const r of roster()) now[r.pos] = (now[r.pos] || 0) + 1;
    for (const pos of Object.keys(now)) {
      if ((now[pos] || 0) > (state.turnRosterCounts[pos] || 0)) return pos;
    }
    return null;
  }

  /**
   * Draft the top queued player who is NOT at the given position.
   *
   * Back-to-back picks are the one case where letting the clock expire twice is
   * actively harmful: Yahoo takes the top of the queue both times, and the top of
   * the queue rarely changes in the seconds between, so a turn can spend both
   * picks on the same position. Splitting them costs nothing — the second-best
   * option at another position is normally worth far more than a third running
   * back — and it only ever fires with the clock nearly gone, so a human pick
   * always takes precedence.
   */
  async function draftDifferentPosition(firstPos) {
    const seen = new Set();
    const candidates = [];
    for (const p of state.queue) {
      if (!p || !p.pos || p.pos === firstPos) continue;
      const k = key(p.name, p.pos);
      if (seen.has(k)) continue;
      seen.add(k); candidates.push(p);
    }
    // If the queue offers nothing else, fall back to the board.
    for (const p of planQueue(CFG.QUEUE_SIZE, [])) {
      if (!p || p.pos === firstPos) continue;
      const k = key(p.name, p.pos);
      if (seen.has(k)) continue;
      seen.add(k); candidates.push(p);
    }
    if (!candidates.length) {
      say(`pair split: nothing queued outside ${firstPos} — leaving the clock alone`);
      return false;
    }

    for (const pl of candidates) {
      const row = await findPlayerRow(pl);
      const btn = row && [...row.querySelectorAll('button')]
        .find((b) => /^draft$/i.test((b.innerText || '').trim()));
      if (!btn) continue;
      btn.click();
      say(`pair split at ${secondsLeft()}s — took ${pl.name} (${pl.pos}) ` +
          `instead of a second ${firstPos}`);
      setSearch('');
      return true;
    }
    say(`pair split: could not draft any non-${firstPos} candidate`);
    setSearch('');
    return false;
  }

  async function draftQueueTop() {
    const candidates = [...state.queue];
    const best = planQueue(1)[0];
    if (best) candidates.push(best);                 // last resort: best available
    if (!candidates.length) { say('autopick: nothing to draft'); return false; }

    for (const pl of candidates) {
      const row = await findPlayerRow(pl);
      const btn = row && [...row.querySelectorAll('button')]
        .find((b) => /^draft$/i.test((b.innerText || '').trim()));
      if (!btn) { say(`autopick: no Draft button for ${pl.name}, trying next`); continue; }
      btn.click();
      say(`AUTOPICK at ${secondsLeft()}s — drafted ${pl.name} (${pl.pos})`);
      setSearch('');
      return true;
    }
    say('autopick: could not draft any candidate');
    setSearch('');
    return false;
  }

  /**
   * Read the pick history off the Picks panel, which holds a rolling window of
   * roughly seventy picks — enough that a burst of autodrafts cannot outrun it.
   *
   * The panel only exists in the DOM while its tab is active, so this switches to
   * it, reads, and switches back to whatever the user was looking at. Done once
   * before regenerating the queue rather than on every tick, to keep the UI still.
   */
  async function syncPicksFromPanel() {
    const t = panelTabs();
    if (!t.picks) return foldPicks();
    const was = activeTab();
    const mustSwitch = !/^Picks$/i.test(was);
    if (mustSwitch) { t.picks.click(); await sleep(450); }
    recordPicks();                       // per-team rosters, for pick projection
    syncLeagueShape();                   // and re-check league size from them
    const n = foldPicks();
    if (mustSwitch && t.queue) { t.queue.click(); await sleep(250); }
    if (n) say(`picks panel: +${n} new (${state.taken.size} drafted overall)`);
    return n;
  }

  const myTurn = () => {
    const t = document.body.innerText.replace(/\s+/g, ' ');
    return /YOUR TURN,\s*DRAFT NOW/i.test(document.title) || /YOUR TURN\s*[•·]/i.test(t);
  };
  const complete = () => /Draft Complete/i.test(document.body.innerText);

  /**
   * Yahoo turns autodraft ON by itself whenever a pick timer expires and a player
   * is auto-selected, and puts up a dialog saying so. Left alone, every subsequent
   * pick is made for you — the opposite of the point here, where you make the
   * picks and the queue is only the fallback.
   *
   * So after each auto-pick: dismiss the dialog and switch autodraft back off.
   * That also restores the interaction Yahoo counts as activity, which is why no
   * separate idle-timer heartbeat is needed.
   */
  /**
   * Autodraft ON renders solid purple WITH `svg[data-icon="checkmark-default"]`;
   * OFF is white with no checkmark. Key on the icon — semantic, not a colour guess.
   */
  function autodraftOn() {
    const b = [...document.querySelectorAll('button')]
      .find((x) => /Autodraft/i.test((x.innerText || '').trim()));
    return !!(b && b.querySelector('svg[data-icon="checkmark-default"]'));
  }

  // The MutationObserver fires many times per second, and the autodraft toggle
  // takes a moment to re-render. Without a cooldown we clicked it repeatedly and
  // risked toggling it straight back ON.
  let lastToggle = 0;
  let lastDismiss = 0;
  /**
   * The autopick dialog cannot be found in the DOM at all — its text is not in
   * document.body, so Yahoo renders it in a CLOSED shadow root that
   * querySelectorAll cannot reach. There is no button available for us to click.
   *
   * Escape does close it (verified live), so that is the only handle we have. The
   * dialog always accompanies autopick switching on, and the toggle's checkmark IS
   * detectable, so Escape goes out whenever we see autodraft enabled.
   */
  function dismissByEscape() {
    for (const target of [document, document.body, document.activeElement].filter(Boolean)) {
      for (const type of ['keydown', 'keyup']) {
        target.dispatchEvent(new KeyboardEvent(type, {
          key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
          bubbles: true, cancelable: true,
        }));
      }
    }
  }

  // Yahoo leaves the autopick toast in the DOM after it is closed — position:fixed,
  // full text intact, simply not rendered. Matching on text alone therefore found a
  // phantom dialog forever and re-clicked its close button every two seconds. Require
  // the node to actually occupy space and be painted.
  function isVisible(el) {
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    for (let n = el, i = 0; n && n !== document.body && i < 12; n = n.parentElement, i++) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    }
    return true;
  }

  function ensureLiveDrafting() {
    let acted = false;

    // The dialog has NO role=dialog and no aria-modal, so it is found by its text.
    // Match on innerText of div/section: textContent also hits inline <script>
    // source that mentions autopick, which is pure noise.
    const carriers = [...document.querySelectorAll('div,section')].filter((e) => {
      const t = e.innerText || '';
      if (!/autopick mode|due to inactivity/i.test(t) || t.length >= 400) return false;
      return isVisible(e);
    });

    if (carriers.length) {
      // Innermost carrier, then climb to whatever is actually positioned as a modal.
      const inner = carriers.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
      let modal = inner;
      for (let n = inner, i = 0; n && i < 8; n = n.parentElement, i++) {
        const cs = getComputedStyle(n);
        if (cs.position === 'fixed' || cs.position === 'absolute' || (+cs.zIndex > 10)) { modal = n; break; }
      }
      const close = [...modal.querySelectorAll('button')]
        .find((b) => /close|dismiss|ok|got it|×|✕/i.test(b.innerText || b.getAttribute('aria-label') || ''))
        || [...modal.querySelectorAll('button')].find((b) => b.querySelector('svg'))
        || [...modal.querySelectorAll('button')].pop();
      // Cooldown: the MutationObserver calls this many times a second and the
      // dialog takes a moment to tear down, so without it the log fills with
      // dozens of identical dismissals per second.
      if (Date.now() - lastDismiss > 2000) {
        lastDismiss = Date.now();
        if (close) { close.click(); say('dismissed autopick dialog'); }
        else { dismissByEscape(); say('dismissed autopick dialog via Escape'); }
        acted = true;
      }
    }

    // Separately: put autodraft back off. The toggle needs a beat to re-render, so
    // rate-limit it or the MutationObserver clicks it repeatedly and flips it on.
    if (autodraftOn() && Date.now() - lastToggle > 3000) {
      lastToggle = Date.now();
      const tog = [...document.querySelectorAll('button')]
        .find((b) => /^Autodraft$/i.test((b.innerText || '').trim()));
      if (tog) { tog.click(); say('autodraft was on — switched off'); acted = true; }
    }
    return acted;
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const state = {
    pool: new Map(),        // id -> player, read once
    taken: new Set(),       // normalized "NAME|POS" of everyone drafted
    queue: [],              // live read of Yahoo's queue; never a durable model
    seenPicks: new Set(),   // pick numbers already folded into `taken`
    armed: false,
    lastRoster: 0,
    initialByPos: {},       // depth each position actually yielded on first read
    exhausted: {},          // positions with nothing left to re-read
    working: false,         // true while we are clicking in the queue UI
    ours: new Set(),        // "NAME|POS" of entries WE added, persisted per room

    queueSynced: false,     // has the queue been read once? see syncQueue
    lastReconciledRound: null,  // reorder once per round of floors, not per pick
    floors: new Map(),      // target pick -> floors; bench reads the deepest
    realised: [],           // {target, round, from, predicted, actual, err} per horizon reached
    pickPos: {},            // overall pick -> position, for scoring attrition
    floorMeta: new Map(),   // target -> {from, goneByPos} so predictions can be graded
    lastFillTurn: null,     // our pick number the last full rebuild was run for
    lastProjApplied: null,  // the projection whose floors the queue order reflects
    removals: {},           // "NAME|POS" -> times YOU have taken him out
    pendingRemoval: new Set(),  // suspected removals, confirmed on the next pass
    vetoed: new Set(),      // struck out after VETO_AFTER removals; never re-queued
    selfRemoved: new Set(), // removals WE made, so they are never counted as yours
    baseline: null,         // worst-starter projection per position; computed once
    teamRosters: {},        // drafter name -> [players], accumulated from the feed
    slotNames: {},          // draft slot -> drafter name, learned from round one
    seenPickNos: new Set(), // overall pick numbers already recorded
    pickDrafter: {},        // overall pick -> drafter, kept raw so slots can be rebuilt
  };

  const key = (name, pos) => `${name.replace(/\s+/g, ' ').trim().toUpperCase()}|${pos}`;

  /**
   * Ownership of queue entries. Anything we did not add ourselves belongs to the
   * human and is never removed — not by prune, not by the post-pick purge, not by
   * the position limit. Such entries still count toward queue size and planning,
   * so we simply stop adding around them.
   *
   * Persisted per draft room: without that, a reload would make our own earlier
   * additions look like the human's and freeze the queue permanently. The queue
   * itself is still read live every cycle; this only records who put each entry
   * there. On a fresh room with no record, everything present is treated as the
   * human's, which is the safe default.
   */
  const roomId = () => (location.pathname.match(/draftclient\/f1\/(\d+)/) || [])[1] || 'x';
  function loadOurs() {
    try {
      const raw = localStorage.getItem(`ys_ours_${roomId()}`);
      if (raw) state.ours = new Set(JSON.parse(raw));
    } catch (e) { /* private browsing */ }
  }
  function saveOurs() {
    try { localStorage.setItem(`ys_ours_${roomId()}`, JSON.stringify([...state.ours])); }
    catch (e) { /* private browsing */ }
  }
  // TRUE when the ASSISTANT queued this player. A queue entry the human added is
  // therefore `!weQueued(p)` — the name isOurs read the other way round to half
  // the call sites and inverted a removal predicate, which made the assistant's
  // own stale entries permanent while targeting the human's.
  const weQueued = (p) => state.ours.has(key(p.name, p.pos));
  // Entries reconciliation must never move: only those observed ARRIVING in the
  // queue without us adding them. Anything else is ours to manage.
  // There is deliberately no "this one is the human's" concept. Every attempt to
  // infer it from the queue produced false positives — M. Pittman Jr., J. Williams
  // and others were marked as the human's despite the assistant having queued them
  // — and the mark meant "never reorder, never remove", which froze entries we had
  // placed ourselves. A queue read simply cannot distinguish "you added this" from
  // "this was already here" across a reload or a tab switch.
  //
  // The assistant therefore manages every entry, and your intent is respected
  // through a signal that IS reliable: pull the same player out VETO_AFTER times
  // and he is never queued again.

  function foldPicks() {
    let n = 0;
    for (const lp of scanLastPick()) {
      if (state.seenPicks.has(lp.pick)) continue;
      state.seenPicks.add(lp.pick);
      state.taken.add(key(lp.name, lp.pos));
      n++;
      state.queue = state.queue.filter((q) => key(q.name, q.pos) !== key(lp.name, lp.pos));
    }
    for (const p of scanPicks()) {
      if (state.seenPicks.has(p.pick)) continue;
      state.seenPicks.add(p.pick);
      n++;
      const m = p.text.match(/^(.+?)\s+\b(QB|RB|WR|TE|K|DEF)\b/);
      if (m) {
        state.taken.add(key(m[1], m[2]));
        // Anyone drafted is out of our queue, whoever took them.
        state.queue = state.queue.filter((q) => key(q.name, q.pos) !== key(m[1], m[2]));
      }
    }
    return n;
  }

  // ---------------------------------------------------------------------------
  // Pick projection (see PROJECTION.md)
  // ---------------------------------------------------------------------------

  /** Positions a flex slot accepts. */
  const FLEX_POS = ['RB', 'WR', 'TE'];
  // Fills a mandatory hole > goes in the starting lineup > sits on the bench.
  //
  // Flex shares a tier with starter deliberately: flex IS a starting slot, so
  // ranking every dedicated-slot player above every flex player would be an
  // arbitrary preference between two spots that both play every week. Within the
  // tier, surplus decides. What the tier does prevent is a bench player
  // outranking either, which is what the backup RB/WR multiplier was doing.
  const ROLE_TIER = { 'must-fill': 0, starter: 1, flex: 1, reserve: 2 };

  /**
   * League baseline: the projection of a replacement-level STARTER at each
   * position. Computed once from the full pool and frozen — it describes the
   * league's shape, not who happens to be undrafted.
   */
  /**
   * The worst-starter baseline is computed ONCE and never recomputed. It describes
   * the league's shape — how good a startable player is at each position — which is
   * a fact about the roster rules and the team count, not about who is still on the
   * board. Recomputing it against a depleting pool walks it steadily downward and
   * silently reprices every pick.
   */
  function computeBaseline() {
    if (state.baselineDone) return state.baseline;
    // Snapshot the pool the FIRST time we compute, and always use that snapshot.
    // The baseline describes the league's shape and must not drift: recomputing
    // from the live pool after picks have happened walks it steadily downward,
    // because the best players are gone. Observed live — RB fell from 108.4 to
    // 92.6 purely because thirty-five players had been drafted in between.
    // Dedup by Yahoo id. The "Drafted" pill turns out to show ALL players, not just
    // the taken ones, so the two reads overlap almost entirely — concatenating them
    // counted every elite player twice and filled the starter slots with fourteen
    // players standing in for twenty-eight. That inflated the RB baseline to 151
    // against a true figure near 108, which silently understates every running back.
    const merged = new Map();
    for (const p of state.pool.values()) merged.set(p.id, { pos: p.pos, proj: p.proj });
    for (const p of state.draftedPool || []) if (!merged.has(p.id)) merged.set(p.id, p);
    const candidate = [...merged.values()];
    if (!state.baselinePool || candidate.length > state.baselinePool.length) {
      state.baselinePool = candidate;
    }
    // One number per position: the projection of the Nth-best player there, where
    // N = TEAMS x slots. RB and WR are given ONE MORE slot than the lineup lists,
    // because the flex is filled from them — with two RB slots the bar is the
    // (TEAMS x 3)-th back, not the (TEAMS x 2)-th. This replaces the old
    // dedicated-then-flex allocation, which arrived at roughly the same place by a
    // longer route and left RB and WR pinned to each other.
    const byPos = {};
    for (const p of state.baselinePool) (byPos[p.pos] = byPos[p.pos] || []).push(p.proj);

    const baseline = {}, reserveBaseline = {};
    for (const [pos, slots] of Object.entries(CFG.STARTERS)) {
      // TWO bars per position, both for opponent projection only.
      //
      // STARTER — the Nth-best where N = TEAMS x starting slots. No flex factor:
      // the flex is modelled by the reserve bar instead of by inflating this one.
      //
      // RESERVE — how deep a team plausibly goes for a backup at that position:
      //   K, DEF   no reserve at all, so the same bar as the starter
      //   QB, TE   one reserve
      //   RB, WR   one reserve PER STARTER, since that is where depth is carried
      const list = (byPos[pos] || []).sort((a, b) => b - a);
      if (!list.length) continue;
      const rank = (n) => list[Math.min(Math.round(n), list.length) - 1];

      baseline[pos] = rank(CFG.TEAMS * slots);

      const reserves = (pos === 'K' || pos === 'DEF') ? 0
        : (pos === 'RB' || pos === 'WR') ? slots
        : 1;
      reserveBaseline[pos] = rank(CFG.TEAMS * (slots + reserves));
    }
    state.baseline = baseline;
    state.reserveBaseline = reserveBaseline;
    state.baselineDone = true;
    say(`baseline starters: ${JSON.stringify(baseline)}`);
    say(`baseline reserves: ${JSON.stringify(reserveBaseline)}`);

    return baseline;
  }

  /**
   * Which slot number picks at a given overall pick, in a snake.
   * Round 1 runs 1..T, round 2 runs T..1, and so on.
   */
  function slotOfPick(overall) {
    const T = CFG.TEAMS;
    const round = Math.ceil(overall / T);
    const idx = (overall - 1) % T;
    return (round % 2 === 1) ? idx + 1 : T - idx;
  }

  /** Our next pick at or after a given overall pick. */
  function ourNextPickAfter(overall) {
    for (let p = overall; p < overall + CFG.TEAMS * 3; p++) {
      if (slotOfPick(p) === CFG.SLOT) return p;
    }
    return overall;
  }

  /**
   * Our Nth pick from here: n=1 is the pick in hand, n=3 the third-from-next.
   * Clamped to the last pick of the draft — unclamped, the closing rounds targeted
   * picks that do not exist (216 in a 210-pick draft) and the simulation removed
   * players for picks nobody ever makes, depressing those floors.
   */
  function ourPickAhead(currentPick, n) {
    let p = ourNextPickAfter(currentPick);
    for (let i = 1; i < n; i++) p = ourNextPickAfter(p + 1);
    return Math.min(p, CFG.TEAMS * rosterSize());
  }

  /** How many picks — ours included — until we are on the clock. */
  const picksUntilOurTurn = (currentPick) => ourNextPickAfter(currentPick) - currentPick;



  /**
   * What one team would take, given its roster and who is left. Models a rational
   * drafter: fill starting slots first by surplus over a replacement starter, then
   * draft for depth with RB/WR weighted up.
   */
  function projectedChoice(roster, pool, pickNo, base, reserveBase, bias) {
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
    const limit = (pos) => CFG.SIM_ROSTER_LIMITS[pos] ?? (CFG.CAPS[pos] ?? 99);

    // A team will not take a third player at one position sharing a bye week.
    const byeBlocked = (p) => p.bye != null &&
      roster.filter((r) => r.pos === p.pos && r.bye === p.bye).length >= 2;

    // O16 — opponents do not take a kicker or defense until the closing rounds,
    // whatever the arithmetic says. Against the static baseline the best defense
    // scores about +20 and the best kicker about +9, which beats a mid-round back
    // at +5, so without this the model drafted eight defenses inside picks 45-98.
    // The surplus is real; the behaviour is not. Nobody spends a fifth-round pick
    // on a defense, and a model of opponents has to model what they do.
    const roundOfPick = Math.ceil(pickNo / CFG.TEAMS);
    const kdefAllowed = roundOfPick > rosterSize() - CFG.SIM_KDEF_LAST_ROUNDS;

    let best = null, bestScore = -Infinity;
    for (const p of pool) {
      if (byeBlocked(p)) continue;
      if (held(p.pos) >= limit(p.pos)) continue;
      if (!kdefAllowed && (p.pos === 'K' || p.pos === 'DEF')) continue;

      // Measured against the bar for the slot this pick would fill, and weighted
      // by whether it fills a starting slot at all. No positional multipliers of
      // any kind: the difference between positions lives entirely in how deep
      // their two bars sit.
      const startingHere = held(p.pos) < (CFG.STARTERS[p.pos] || 0);
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
      const weight = startingHere ? CFG.WEIGHT_STARTER : CFG.WEIGHT_RESERVE;
      const score = (p.proj - bar) * weight + (bias ? bias(p.pos) : 0);

      // Ties go to running back.
      if (score > bestScore || (score === bestScore && p.pos === 'RB' && best && best.pos !== 'RB')) {
        best = p; bestScore = score;
      }
    }
    return best;
  }

  /**
   * Play the draft forward from the last completed pick to our subsequent pick,
   * and report the best projection expected to survive at each position.
   */

  async function projectAvailability(currentPick, targetPick) {
    if (!state.baseline) return null;
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
     * simulated, and the floors this run produces are not written to state.floors
     * until it has returned. A projection can therefore never read itself.
     */
    const base = state.baseline;
    const reserveBase = state.reserveBaseline || {};

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
        for (const q of Object.keys(CFG.STARTERS)) {
          const spread = Math.abs((base[q] ?? 0) - (reserveBase[q] ?? base[q] ?? 0));
          t[q] = CFG.SIM_JITTER * spread * (Math.random() * 2 - 1);
        }
      }
      return t[pos] || 0;
    };
    const mine = new Set(roster().map((r) => key(r.name, r.pos)));

    // Everyone still on the board, best first.
    const pool = [...state.pool.values()]
      .filter((p) => !state.taken.has(key(p.name, p.pos)) && !mine.has(key(p.name, p.pos)))
      .sort((a, b) => b.proj - a.proj);

    // ACTUAL rosters and PROJECTED rosters are kept strictly apart. The
    // simulation adds imaginary picks, so it works on copies; state.teamRosters
    // only ever changes when a real pick is observed in the feed. Every rebuild
    // re-forks from the current actual rosters, so a projection is never seeded
    // with the previous projection's guesses.
    const projectedRosters = {};
    for (const [name, list] of Object.entries(state.teamRosters || {})) {
      projectedRosters[name] = list.map((p) => ({ ...p }));
    }

    const gone = new Set();
    let simulated = 0;
    for (let p = currentPick; p < target; p++) {
      const slot = slotOfPick(p);
      if (slot === CFG.SLOT) continue;                 // our own picks are not simulated
      const who = (state.slotNames || {})[slot] || `slot${slot}`;
      const rost = projectedRosters[who] || (projectedRosters[who] = []);
      const choice = projectedChoice(rost, pool.filter((x) => !gone.has(x.id)), p, base,
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

  // ---------------------------------------------------------------------------
  // Valuation — same model as the autodraft script
  // ---------------------------------------------------------------------------

  /**
   * League size and our slot are DISCOVERED, not configured. Setting TEAMS by hand
   * is silent corruption waiting to happen: a 12 in a 14-team room throws off every
   * slot mapping, mis-attributes every pick to the wrong team, and poisons the whole
   * projection — with nothing in the output that looks obviously wrong.
   *
   * Slot comes from the draft-room URL, which is authoritative and available
   * immediately. Team count comes from the room's own list of OUR picks, which
   * reads "Round 1, Pick 7 (7th Overall) / Round 2, Pick 8 (22nd Overall) / ...":
   * for a snake, round 1 and round 2 overalls sum to 2T + 1, so
   * T = (7 + 22 - 1) / 2 = 14.
   *
   * That list is NOT rendered before the draft starts — verified in a live room
   * with the countdown still running — so team count reports whether it is
   * CONFIRMED. The baseline is computed once and can never be revised, so it waits
   * for confirmation rather than freezing itself against a default that happens to
   * be wrong. A 12 assumed in a 14-team room throws off every slot mapping,
   * mis-attributes every pick, and poisons the projection, with nothing in the
   * output that looks obviously wrong.
   */
  function detectSlot() {
    const m = location.pathname.match(/draftclient\/f1\/\d+\/(\d+)/);
    return m ? +m[1] : CFG.SLOT;
  }
  /** Our pick schedule as [{round, pick, overall}], in round order. */
  function pickSchedule() {
    const out = [];
    const re = /Round\s+(\d+),\s*Pick\s+(\d+)\s*\((\d+)(?:st|nd|rd|th)\s+Overall\)/gi;
    for (const m of document.body.innerText.matchAll(re)) {
      out.push({ round: +m[1], pick: +m[2], overall: +m[3] });
    }
    return out.sort((a, b) => a.round - b.round);
  }
  /**
   * Narrow the league size from the header alone.
   *
   * Every "ROUND r, PICK n" the room displays is a constraint: pick n falls in
   * round r exactly when (r-1)*T < n <= r*T. Intersecting those over a few picks
   * pins T down without needing any list of teams. Round 1 pick 14 says T >= 14;
   * round 2 pick 15 says T < 15; together, T = 14.
   *
   * This is used in preference to counting distinct drafters, which is wrong twice
   * over: early in a draft the count of drafters trivially equals the count of
   * picks, and drafter names are not unique — one live room held two "Mark", two
   * "Marcuss" and two "Jason", which would have merged six teams into three.
   */
  function observeShape() {
    const { round, overall } = draftPosition();
    if (!(round > 0 && overall > 0)) return;
    state.shapeSeen = state.shapeSeen || new Set();
    const seen = `${round}:${overall}`;
    if (state.shapeSeen.has(seen)) return;
    state.shapeSeen.add(seen);
    if (!state.teamCandidates) {
      state.teamCandidates = new Set(Array.from({ length: 31 }, (_, i) => i + 2));  // 2..32
    }
    const before = state.teamCandidates.size;
    for (const t of [...state.teamCandidates]) {
      if (!(overall > (round - 1) * t && overall <= round * t)) state.teamCandidates.delete(t);
    }
    if (!state.teamCandidates.size) {
      // Contradiction: something was mis-parsed. Start over rather than lock in.
      say('league size: observations contradict each other — restarting the narrowing');
      state.teamCandidates = null;
      state.shapeSeen = new Set();
      return;
    }
    if (before > 1 && state.teamCandidates.size === 1) {
      say(`league size narrowed to ${[...state.teamCandidates][0]} from the round/pick header`);
    }
  }

  /**
   * Count the teams directly, from the draft-order strip the room already renders.
   *
   * That strip lists every upcoming pick in order — for a 14-team, 15-round draft,
   * 210 entries — and a snake order mirrors at the turn: "... Hugh, Ira, Ira,
   * Hugh ...". The position of that mirror IS the team count. It is positional, so
   * duplicate manager names cannot break it, and the mirror itself is a check: the
   * first 2T entries must read the same forwards and backwards.
   *
   * The container's class names are obfuscated and change, so it is found by that
   * structure rather than by selector.
   */
  function detectTeamsFromOrder() {
    let best = null;
    for (const el of document.querySelectorAll('div,ul,ol')) {
      const kids = el.children;
      if (kids.length < 16 || kids.length > 800) continue;
      const names = [...kids].map((c) => (c.innerText || '').trim().split('\n')[0]);
      if (names.some((n) => !n)) continue;
      let pivot = -1;
      for (let i = 1; i < names.length - 1; i++) {
        if (names[i] === names[i + 1]) { pivot = i; break; }
      }
      const t = pivot + 1;
      if (t < 4 || t > 32 || names.length < 2 * t) continue;
      let mirrors = true;                       // names[i] === names[2t-1-i]
      for (let i = 0; i < t && mirrors; i++) if (names[i] !== names[2 * t - 1 - i]) mirrors = false;
      if (mirrors && (!best || kids.length > best.count)) best = { teams: t, count: kids.length };
    }
    return best ? best.teams : null;
  }

  /** @returns {{teams:number, confirmed:boolean}} */
  function detectTeams() {
    // Read it off the draft order if the strip is up. This is a count, not an
    // inference, and it is available from the first pick.
    const counted = detectTeamsFromOrder();
    if (counted) return { teams: counted, confirmed: true };

    const sched = pickSchedule();
    const r1 = sched.find((x) => x.round === 1);
    const r2 = sched.find((x) => x.round === 2);
    if (r1 && r2) {
      const t = (r1.overall + r2.overall - 1) / 2;
      if (Number.isInteger(t) && t >= 2 && t <= 32) {
        // Cross-check against round 3 when it is there: overall(r3) = 2T + slot.
        const r3 = sched.find((x) => x.round === 3);
        if (!r3 || r3.overall === 2 * t + r1.pick) return { teams: t, confirmed: true };
        say(`league size: schedule disagrees with itself (r3 ${r3.overall} vs ${2 * t + r1.pick})`);
      }
    }
    // Then the header constraints, once they leave exactly one possibility.
    if (state.teamCandidates && state.teamCandidates.size === 1) {
      return { teams: [...state.teamCandidates][0], confirmed: true };
    }
    // Last resort: distinct drafters, but only once the order has WRAPPED — some
    // drafter has picked twice. In a snake that happens exactly when round 1 ends,
    // so it is the first moment every team has appeared. Without this the count is
    // trivially satisfied at pick 4 of a 14-team room, which froze a baseline
    // against 4 teams.
    const counts = {};
    for (const who of Object.values(state.pickDrafter || {})) counts[who] = (counts[who] || 0) + 1;
    const names = Object.keys(counts);
    if (names.length > 1 && Object.values(counts).some((n) => n >= 2)) {
      return { teams: names.length, confirmed: true };
    }
    return { teams: CFG.TEAMS, confirmed: false };
  }
  function syncLeagueShape() {
    const slot = detectSlot();
    const { teams, confirmed } = detectTeams();
    state.teamsConfirmed = confirmed;
    if (slot !== CFG.SLOT) { say(`slot detected as ${slot} (config said ${CFG.SLOT})`); CFG.SLOT = slot; }
    if (confirmed && teams !== CFG.TEAMS) {
      say(`league size detected as ${teams} (config said ${CFG.TEAMS})`);
      CFG.TEAMS = teams;
      // Slot numbers are derived from league size, so every mapping recorded
      // under the old count is wrong. Rebuild them from the raw pick log rather
      // than leaving stale pairings behind.
      state.slotNames = {};
      for (const [overall, who] of Object.entries(state.pickDrafter || {})) {
        state.slotNames[slotOfPick(+overall)] = who;
      }
      if (state.baselineDone) {
        // Should not happen: the shape comes from the pick schedule, which is up
        // before the draft starts, so it is known before the baseline is computed.
        say('WARNING league size changed after the baseline was fixed — it is now wrong');
      }
    }
  }

  /**
   * The projection, run once per round and cached.
   *
   * It answers one question per position — what will still be there at our
   * subsequent pick — and that answer does not meaningfully change between two
   * picks in the same round, so recomputing it per candidate was pure waste. It
   * used to run inside rankAvailable, which planQueue calls once per queue slot:
   * eight full simulations of up to thirty picks over a five-hundred-player pool
   * for a single refill, all synchronous. That is what froze the tab.
   *
   * Two survivors are kept per position rather than one, so a player is never
   * measured against himself — the bug that made the top receiver at a position
   * score zero surplus and concluded that passing on him would leave him there.
   */
  /**
   * Project once per turn, shortly before we are on the clock, out to our
   * THIRD-from-next pick.
   *
   * Running it close to our turn is the point: it then reflects the picks that
   * have actually just happened, so a run on a position is priced in rather than
   * being averaged away by a projection computed at the top of the round.
   *
   * Every horizon's floors are kept, not just the latest. Starters are measured
   * against the near floor and bench players against the deepest one available —
   * a bench player can wait, so the honest question for him is what is left at the
   * far end, not at our next pick.
   */
  async function ensureProjection(currentPick, force) {
    if (!state.baseline) return null;
    const away = picksUntilOurTurn(currentPick);
    // Refresh near our turn — but there must ALWAYS be floors to value against.
    // Deferring the first projection until three picks out left the opening of the
    // draft with none, so valuation fell back to the ADP survival model: the very
    // model this replaced, and the one that prices kickers against the end of the
    // draft and hands the best of them an enormous surplus. Kickers went straight
    // to the top of the queue.
    if (!force && state.proj && away > CFG.PROJECT_AT_PICKS_AWAY) return state.proj;
    if (!force && !state.proj && away > CFG.PROJECT_AT_PICKS_AWAY && state.floors.size) return state.proj;
    const turn = ourNextPickAfter(currentPick);
    if (state.proj && state.proj.turn === turn && state.proj.teams === CFG.TEAMS) return state.proj;
    const rd = roundNow();
    const started = Date.now();
    const sim = await projectAvailability(currentPick, ourPickAhead(currentPick, 3));
    if (!sim) return null;
    const tookMs = Date.now() - started;
    const byPos = {};
    for (const [pos, list] of Object.entries(sim.expected)) {
      byPos[pos] = list.slice(0, 12).map((p) => ({ id: p.id, proj: p.proj }));
    }
    // Diagnostics: how many picks were simulated, and what the model thinks goes.
    // A floor is only as good as the attrition behind it, and "how many receivers
    // disappear before my next-but-one pick" is the number to sanity-check.
    const goneByPos = {};
    for (const id of sim.gone) {
      const pl = state.pool.get(id);
      if (pl) goneByPos[pl.pos] = (goneByPos[pl.pos] || 0) + 1;
    }
    state.proj = { round: rd, turn, teams: CFG.TEAMS, target: sim.target, byPos,
                   from: currentPick, simulated: sim.simulated, goneByPos, tookMs };
    // Keep every horizon we have computed, keyed by the pick it reached. Bench
    // valuation reads the deepest of them.
    state.floors.set(sim.target, byPos);
    state.floorMeta.set(sim.target, { from: currentPick, goneByPos, round: rd });
    const shown = Object.entries(byPos)
      .map(([pos, l]) => `${pos} ${l.length ? l[0].proj : '-'}`).join(', ');
    // Label with the round the horizon is anchored to — the round of the pick we
    // are about to make — not the room's current round; past our own pick in a
    // round those differ, and the log read "round 13" while measuring from 14.
    const anchor = Math.ceil(ourNextPickAfter(currentPick) / CFG.TEAMS);
    say(`projection from round ${anchor} (picks ${currentPick}-${sim.target}, ` +
        `${sim.simulated} simulated in ${tookMs}ms, gone ${JSON.stringify(goneByPos)}): ${shown}`);
    return state.proj;
  }

  const gapTo = (rd) => (rd % 2 === 1 ? 2 * (CFG.TEAMS - CFG.SLOT) + 1 : 2 * CFG.SLOT - 1);
  /**
   * Where the draft actually is, as {round, overall}.
   *
   * Yahoo writes two different things in the same shape. The header reads
   * "ROUND 11, PICK 147", where the pick is the OVERALL pick. Our own pick
   * schedule reads "Round 2, Pick 8 (22nd Overall)", where it is the pick within
   * the round. A regex that matches both takes whichever comes first in the DOM,
   * which would silently report round 1 pick 7 in the middle of round 11. The
   * trailing "(...)" is what separates them.
   */
  const POSITION_RE = /Round\s*(\d+),\s*Pick\s*(\d+)(\s*\(\s*\d+(?:st|nd|rd|th)\s+Overall\s*\))?/gi;
  function draftPosition(text) {
    for (const m of (text ?? document.body.innerText).matchAll(POSITION_RE)) {
      if (!m[3]) return { round: +m[1], overall: +m[2] };   // header form, no "(Nth Overall)"
    }
    // No header: fall back to counting what has been drafted.
    const drafted = state.taken ? state.taken.size : 0;
    return { round: Math.floor(drafted / CFG.TEAMS) + 1, overall: drafted + 1 };
  }
  const roundNow = () => draftPosition().round;

  /** Per-team playoff modifier from team-context.gen.js; 1.0 when absent. */
  function playoffModifier(team) {
    const ctx = window.YS_TEAM_CONTEXT;
    if (!ctx || !CFG.PLAYOFF_SWING) return 1;
    const m = ctx.teams?.[(team || '').toUpperCase()]?.mod;
    if (!Number.isFinite(m)) return 1;
    // Rescale if the generated file used a different swing than configured here.
    return ctx.swing === CFG.PLAYOFF_SWING ? m
      : 1 + (m - 1) * (CFG.PLAYOFF_SWING / (ctx.swing || CFG.PLAYOFF_SWING));
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
  function sameTeamMultiplier(player, have) {
    if (!CFG.SAME_TEAM_PENALTY || !player.team) return 1;
    if (player.pos === 'K' || player.pos === 'DEF') return 1;
    const teammates = have.filter((h) => h.team && h.team === player.team
      && h.pos !== 'K' && h.pos !== 'DEF').length;
    // Compounds: a third player from the same team is penalised more than the
    // second. This can push a player below replacement, which is intended.
    return Math.pow(1 - CFG.SAME_TEAM_PENALTY, teammates);
  }

  function byeMultiplier(player, have) {
    if (!CFG.BYE_FACTOR || !player.bye) return 1;
    const clash = have.filter((h) => h.pos === player.pos && h.bye === player.bye).length;
    const slots = Math.max(1, CFG.STARTERS[player.pos] || 1);
    return 1 - CFG.BYE_FACTOR * Math.min(1, clash / slots);
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
  function bestAvailableNow() {
    const mine = new Set(roster().map((r) => key(r.name, r.pos)));
    const best = {};
    for (const p of state.pool.values()) {
      const k = key(p.name, p.pos);
      if (state.taken.has(k) || mine.has(k)) continue;
      if (best[p.pos] === undefined || p.proj > best[p.pos]) best[p.pos] = p.proj;
    }
    return best;
  }

  function rankAvailable(extra) {
    const have = roster().concat(extra || []);
    const planned = new Set((extra || []).map((e) => e.id));
    const size = rosterSize();
    const rd = roundNow();
    const count = (p) => have.filter((x) => x.pos === p).length;
    const mine = new Set(have.map((h) => key(h.name, h.pos)));

    // Players already in the queue STAY in the ranking. Excluding them boxed us
    // out of our own best options: planQueue could never name a player we had
    // queued, so the ideal plan and the live queue shared nothing, every entry
    // looked stale to reconciliation, and the whole queue was torn down and
    // rebuilt every cycle. Callers that add to the queue skip what is already
    // there themselves.
    const avail = [...state.pool.values()]
      .filter((p) => !state.taken.has(key(p.name, p.pos)))
      .filter((p) => !mine.has(key(p.name, p.pos)))
      .filter((p) => !planned.has(p.id))
      .filter((p) => !state.vetoed.has(key(p.name, p.pos)));

    // A required position we can no longer defer overrides everything.
    const missing = Object.entries(CFG.STARTERS)
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
    const currentPick = draftPosition().overall;

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
    const projected = state.proj || null;

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
    const liveBest = bestAvailableNow();

    /** Floors from the deepest horizon we have projected, for bench valuation. */
    const deepestFloors = () => {
      let best = null, bestAt = -1;
      for (const [at, byPosn] of state.floors) if (at > bestAt) { bestAt = at; best = byPosn; }
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
      .reduce((n, p) => n + Math.max(0, count(p) - CFG.STARTERS[p]), 0);

    // The cap is a hard exclusion. The late-round gate is NOT: it blocks
    // selection only, so gated players are still valued and the overlay can
    // explain them rather than showing a blank row.
    const legal = (p) => count(p.pos) < CFG.CAPS[p.pos];
    const isGated = (p) => CFG.LATE_ONLY.includes(p.pos) && rd < size - 1;

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
      let weight = CFG.WEIGHT_STARTER, role = 'starter';
      if (count(p.pos) >= CFG.STARTERS[p.pos]) {
        if (FLEX_POS.includes(p.pos) && flexUsed < CFG.FLEX) {
          weight = CFG.WEIGHT_FLEX; role = 'flex';
        } else {
          weight = CFG.WEIGHT_RESERVE; role = 'reserve';
        }
      }

      // Role decides which bar applies, so it must be settled first.
      const bar = role === 'flex' ? flexReplacement(p.id) : replacement(p.pos, p.id, role);

      // DISPLAYED value: the pure surplus, carrying no modifiers whatsoever.
      // Everything that shapes preference is applied below, to the sort key only,
      // so the number on screen always means one thing: points above what you
      // could get at this slot if you passed.
      const raw = p.proj - bar;

      const pm = playoffModifier(p.team);
      const bm = byeMultiplier(p, have);
      const teamMod = sameTeamMultiplier(p, have);

      // A bench RB or WR carries three times the weight of a bench player
      // elsewhere. Applied to the role weight, so 0.2 becomes 0.6 for them.
      const benchMult = (role === 'reserve' && (p.pos === 'RB' || p.pos === 'WR'))
        ? CFG.BENCH_RB_WR_MULTIPLIER : 1;
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

  /**
   * Do we pick twice with nobody in between? In a snake the gap to your next pick
   * is 2(T-s)+1 after an odd round and 2s-1 after an even one, so it equals 1 only
   * at the two endpoint seats (s = 1 or s = TEAMS). Every middle seat always has
   * at least one opposing pick in between.
   */
  const backToBack = () => gapTo(roundNow()) === 1;

  /** Positions where we can only take one more before hitting the cap. */
  const isScarce = (pos, have) =>
    (CFG.CAPS[pos] || 0) - have.filter((h) => h.pos === pos).length === 1;

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
   * Yahoo's REAL queue, read straight off the panel. Readable only while the
   * Queue tab is active, so returns null when it is not; callers decide whether
   * to switch tabs for it.
   */
  function liveQueue() {
    if (!/^Queue/i.test(activeTab())) return null;
    return [...document.querySelectorAll('.ys-player')]
      .filter((e) => /ADP:/.test(e.innerText))
      .map(parsePlayer).filter(Boolean);
  }

  /**
   * Refresh state.queue from the page, switching to the Queue tab if needed and
   * restoring whatever the human was looking at.
   *
   * We deliberately keep NO durable model of the queue. The human can reorder it,
   * delete from it, or add to it at any moment, and a reload wipes anything we
   * remembered — so every decision is made against what is actually on screen.
   * Player attributes are the one thing Yahoo does not change mid-draft, which is
   * why the pool is read once and only availability is tracked over time.
   */
  async function syncQueue() {
    const tabs = panelTabs();
    const was = activeTab();
    const mustSwitch = !/^Queue/i.test(was);
    if (mustSwitch && tabs.queue) { tabs.queue.click(); await sleep(450); }

    /**
     * An unreadable queue is NOT an empty queue.
     *
     * liveQueue() returns null unless the Queue tab is the active one, and this
     * used to coerce that to []. The next read then saw every row as a brand-new
     * arrival and flagged the lot as YOURS — which is how players the assistant
     * queued itself, M. Pittman Jr. and J. Williams among them, acquired a mark
     * that means "never reorder, never remove". Bail out instead and keep what we
     * already know.
     */
    const live = liveQueue();
    if (!live) return state.queue;
    if (!live.length && queueCount() > 0) return state.queue;   // mid-render

    /**
     * Work out which entries the human added, so reconciliation can leave those
     * alone and rearrange the rest.
     *
     * An entry we did not add is only evidence of a human once we have seen the
     * queue at least once: on the FIRST sync after arming, anything unrecognised
     * is far more likely to be our own leftover from a reload than a human pick.
     * Treating those as the human's made them permanent — a live queue ended up
     * led by two kickers and a defense that no reconciliation could remove, ahead
     * of a running back worth +93.6, and the K:1 cap was breached because the
     * strays accumulated across reloads.
     */
    if (state.queueSynced) {
      /**
       * Count the players YOU pull out of the queue, and after VETO_AFTER of them
       * stop putting that player back.
       *
       * Judged in two passes. A player who vanishes from the queue has usually
       * just been drafted, and the picks feed can lag the queue by a moment — a
       * single-pass version blamed the human for a departure that was really a
       * pick. So a disappearance is only SUSPECTED here, and counted on the next
       * pass, once the feed has caught up and he is still undrafted.
       */
      const now = new Set(live.map((p) => key(p.name, p.pos)));
      for (const k of [...state.pendingRemoval]) {
        state.pendingRemoval.delete(k);
        if (now.has(k) || state.taken.has(k)) continue;      // came back, or was drafted
        const n = (state.removals[k] = (state.removals[k] || 0) + 1);
        if (n >= CFG.VETO_AFTER) {
          state.vetoed.add(k);
          say(`${k} removed ${n} times — will not queue again`);
        } else {
          say(`${k} removed by you (${n}/${CFG.VETO_AFTER})`);
        }
      }
      for (const prev of state.queue || []) {
        if (!prev || !prev.pos) continue;
        const k = key(prev.name, prev.pos);
        if (now.has(k) || state.taken.has(k)) continue;
        if (state.selfRemoved.has(k)) { state.selfRemoved.delete(k); continue; }
        state.pendingRemoval.add(k);
      }
    }
    state.queueSynced = true;

    // Resolve each entry against the pool so we recover id, projection and value.
    state.queue = live.map((p) => {
      // Resolve by Yahoo id. Names are abbreviated to an initial and they COLLIDE:
      // two different running backs both read "B. Robinson", so matching on
      // name+position attached one man's projection to the other. A queue entry
      // showed -113.5 — the lesser Robinson's figure against the better one.
      const hit = (p.id && state.pool.get(p.id))
        || [...state.pool.values()].find((x) => x.name === p.name && x.pos === p.pos);
      return Object.assign({}, p, hit || {});
    });

    if (mustSwitch && tabs.picks && /^Picks$/i.test(was)) { tabs.picks.click(); await sleep(250); }
    else if (mustSwitch && tabs.queue && was && !/^Queue/i.test(was)) { /* leave on Queue */ }
    return state.queue;
  }

  /** The queue's current contents, valued as if they were not queued. */
  function queueView() {
    const saved = state.queue;
    state.queue = [];
    let ranked;
    try { ranked = rankAvailable([]); } finally { state.queue = saved; }
    // Keyed by Yahoo id FIRST. Abbreviated names collide — the pool held two
    // "J. Daniels" at QB, one projecting 303.79 and one 18.1 — and a Map keyed on
    // name+position silently keeps whichever came last. The queue row carried the
    // right id all along, so the ranking said +19.49 while the queue displayed
    // -266.2 for the same player: 18.1 measured against a 284.3 floor.
    const byId = new Map(ranked.filter((p) => p.id).map((p) => [p.id, p]));
    const byKey = new Map(ranked.map((p) => [key(p.name, p.pos), p]));
    return saved.map((q) => (q.id && byId.get(q.id))
      || byKey.get(key(q.name, q.pos))
      || Object.assign({}, q, { val: null }));
  }

  /**
   * How many queue slots one position may occupy. Keeping this below the queue
   * size guarantees the queue always offers a genuine alternative rather than
   * five variations on the same decision — if a run empties that position, the
   * rest of the queue is still useful.
   */
  const positionLimit = (pos) => {
    // K and DEF get two slots — a pick and a FALLBACK. There is exactly one of
    // each worth having at any moment, so if ours is sniped between the rebuild
    // and our clock, one slot leaves nothing behind him but negative surplus.
    //
    // This used to collapse to 1 on back-to-back picks, to stop a turn spending
    // both of them on kickers. Q10 already prevents that where it actually
    // happens — at the draft click, by position, verified live — so the cap was a
    // second lock on a door already held, and the only thing it really did was
    // strip the fallback out of every turn-slot queue. Round 13 at a turn slot:
    // top kicker queued, no kicker behind him, everyone below him negative.
    if (pos === 'K' || pos === 'DEF') return 2;
    return Math.max(1, CFG.QUEUE_SIZE - 2);
  };

  function planQueue(n, seed = null) {
    const b2b = backToBack();
    // Players ALREADY queued must count as provisional roster additions. Refilling
    // one slot at a time re-planned against the roster alone, so each pass added
    // another defense: a live queue reached DEF,K,DEF,DEF,K and autodraft put two
    // defenses on the roster before it was caught.
    const queued = (seed || queueView()).filter((p) => p && p.pos && p.pos !== '?');
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
      // rankAvailable([]) — NOT rankAvailable(chosen).
      //
      // rankAvailable derives roles from roster().concat(extra), so passing the
      // players chosen so far makes the plan fill its own notional lineup: after a
      // couple of backs and receivers are picked, every FURTHER back and receiver
      // is judged bench and multiplied by 0.2, while the still-empty kicker and
      // defense slots keep full starter weight. That is what put a kicker worth
      // +2.1 and a defense worth +6.1 into a round-3 queue ahead of a back worth
      // +42.9. Roles must reflect the roster we actually have.
      //
      // Dedup is handled by the id filter below and stacking by posCount, so
      // nothing is lost by not seeding.
      const ranked = rankAvailable([])
        .filter((p) => !chosen.some((c) => c.id === p.id))
        .filter((p) => !p.gated)                       // late-round gate applies here
        .filter((p) => (posCount[p.pos] || 0) < positionLimit(p.pos));
      if (!ranked.length) break;
      const pick = ranked[0];
      chosen.push(pick);
      posCount[pick.pos] = (posCount[pick.pos] || 0) + 1;
      if (chosen.length === 1 && !queued.length && !b2b && isScarce(pick.pos, roster())) {
        const backup = rankAvailable([]).find((p) => p.pos === pick.pos && p.id !== pick.id);
        if (backup && chosen.length < n) chosen.push(backup);
      }
    }

    return chosen;
  }

  // ---------------------------------------------------------------------------
  // Acting on the queue
  // ---------------------------------------------------------------------------

  const searchBox = () => document.querySelector('input[placeholder*="Search" i]');
  function setSearch(v) {
    const box = searchBox();
    if (!box) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(box, v);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Wait until the player table has actually re-rendered, rather than guessing
   * with a fixed sleep. Measured live: a centre-tab switch and a position-filter
   * change both settle in about 100ms, so the old 1500ms sleeps spent roughly
   * nine seconds of every pool read doing nothing — long enough that a read
   * starting near your turn was still running when the clock mattered.
   */
  async function waitForTable({ minRows = 1, changedFrom = null, timeout = 2500 } = {}) {
    const first = () => {
      const el = document.querySelector('table tbody tr .ys-player[data-id]');
      return el ? el.innerText.split('\n')[0].trim() : null;
    };
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const n = document.querySelectorAll('.ys-player[data-id]').length;
      if (n >= minRows && (changedFrom === null || first() !== changedFrom)) return true;
      await sleep(80);
    }
    return false;
  }
  const firstRowName = () => {
    const el = document.querySelector('table tbody tr .ys-player[data-id]');
    return el ? el.innerText.split('\n')[0].trim() : null;
  };

  /**
   * Add one player by Yahoo id. If their row is not currently rendered, find them
   * through the search box and put it back afterwards — the table is the user's
   * working view and must be left as we found it.
   */
  /** Add (want=true) or remove (want=false) one player from Yahoo's queue. */
  async function toggleQueue(player, want) {
    let el = document.querySelector(`.ys-addqueue[data-id="${player.id}"]`);
    let usedSearch = false;
    const prev = searchBox()?.value ?? '';
    if (!el) {
      if (!setSearch((player.name || '').replace(/^[A-Z]\.\s*/, ''))) return false;
      usedSearch = true;
      await sleep(1000);
      el = document.querySelector(`.ys-addqueue[data-id="${player.id}"]`);
    }
    let ok = false;
    if (el) {
      const before = queueCount();
      if (CFG.DRY_RUN && want) { say(`DRY RUN would queue ${player.name}`); ok = true; }
      else {
        el.click();
        await sleep(650);
        const after = queueCount();
        ok = want ? after > before : after < before;   // trust the badge, not the click
      }
    } else {
      // No row even after searching means the player is gone from the board —
      // drafted while our pick tracking had a gap. Mark them unavailable so the
      // ranking stops offering them; otherwise the refill retries the same three
      // names every tick and the queue never fills.
      if (want) {
        state.taken.add(key(player.name, player.pos));
        say(`${player.name} has no row — treating as drafted`);
      }
    }

    if (usedSearch) { setSearch(prev); await sleep(500); }
    return ok;
  }

  /**
   * Always hand the table back readable: All Positions, no search text. Restoring
   * "whatever it was" left our own last filter applied, so the human was looking at
   * a filtered board without knowing why.
   */
  async function clearFilters() {
    const sel = posFilter();
    if (sel && sel.selectedIndex !== 0) {
      sel.value = sel.options[0].value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(600);
    }
    const box = searchBox();
    if (box && box.value) { setSearch(''); await sleep(400); }
  }

  /**
   * Remove entries through the QUEUE PANEL, not the player table. Once a player is
   * drafted or filtered out of the table there is no star left to click there, so
   * table-based removal silently fails. Each queue row has its own
   * `svg[data-icon="star-filled"]` button, which always works.
   */
  async function removeFromQueue(pred) {
    const tabs = panelTabs();
    const was = activeTab();
    const mustSwitch = !/^Queue/i.test(was);
    if (mustSwitch && tabs.queue) { tabs.queue.click(); await sleep(700); }
    const removed = [];
    for (let guard = 0; guard < 12; guard++) {
      const items = [...document.querySelectorAll('.ys-player')].filter((e) => /ADP:/.test(e.innerText));
      let target = null, info = null;
      for (const e of items) {
        const pl = parsePlayer(e);
        if (pl && pred(pl)) { target = e; info = pl; break; }
      }
      if (!target) break;
      const btn = [...(target.closest('li,div[class*="D(f)"]') || target.parentElement)
        .querySelectorAll('button')].find((b) => b.querySelector('svg[data-icon="star-filled"]'));
      if (!btn) break;
      const before = queueCount();
      btn.click();                        // info captured BEFORE the node detaches
      await sleep(700);
      if (queueCount() >= before) break;
      removed.push(`${info.name} (${info.pos})`);
      state.selfRemoved.add(key(info.name, info.pos));   // ours, never counted as yours
      state.queue = state.queue.filter((q) => !(q.name === info.name && q.pos === info.pos));
    }
    if (mustSwitch && /^Picks$/i.test(was) && tabs.picks) { tabs.picks.click(); await sleep(250); }
    if (removed.length) say(`removed from queue: ${removed.join(', ')}`);
    return removed;
  }

  /**
   * Drop queue entries that are no longer legal. Once a kicker or defense is on the
   * roster we will essentially never want another, so every remaining one is pulled
   * immediately — a live draft ended up with two defenses because stale queue
   * entries were still there when the clock expired.
   */
  async function pruneQueue() {
    const have = roster();
    const view = queueView();
    const bad = new Set();
    const mark = (p) => bad.add(`${p.name}|${p.pos}`);

    // The queue is insertion-ordered and Yahoo drafts from the top, so a stale
    // zero-value entry above a needed position would be taken first and leave the
    // roster illegal. Once required positions cannot be deferred, nothing else
    // belongs in the queue.
    const count = (pos) => have.filter((x) => x.pos === pos).length;
    const missing = Object.entries(CFG.STARTERS)
      .flatMap(([p, k]) => Array(Math.max(0, k - count(p))).fill(p));
    const picksLeft = rosterSize() - have.length;
    if (picksLeft > 0 && missing.length >= picksLeft) {
      const needed = new Set(missing);
      const wrong = view.filter((p) => !needed.has(p.pos));
      if (wrong.length) {
        say(`must-fill ${[...needed].join('/')} with ${picksLeft} picks left — ` +
            `clearing ${wrong.length} other entries`);
        wrong.forEach(mark);
      }
    }

    const seen = {};
    for (const p of view) {
      if (bad.has(`${p.name}|${p.pos}`)) continue;
      // Once a K or DEF is on the roster we will essentially never want another.
      if ((p.pos === 'K' || p.pos === 'DEF') && count(p.pos) >= (CFG.CAPS[p.pos] || 1)) {
        mark(p); continue;
      }
      if (p.val === null) { mark(p); continue; }     // drafted, or capped out
      // No position may occupy more than QUEUE_SIZE-2 slots, so the queue always
      // holds a genuine alternative rather than variations on one decision.
      seen[p.pos] = (seen[p.pos] || 0) + 1;
      if (seen[p.pos] > positionLimit(p.pos)) mark(p);
    }


    if (!bad.size) return [];
    const out = await removeFromQueue((pl) => bad.has(`${pl.name}|${pl.pos}`));
    await clearFilters();
    return out;
  }

  /** Clear the whole queue — used after WE draft, since our needs changed. */
  /**
   * Our own pick invalidates the queue's premise, so it is rebuilt against the new
   * roster — but as a diff, not a purge. Emptying the queue and re-adding was
   * observed re-queueing the identical five players, and it leaves the queue at
   * zero for several seconds; if the clock expires in that window Yahoo drafts off
   * its own rankings instead of ours. Plan the queue afresh (seeded with nothing,
   * so current contents get no incumbency), keep whatever still earns its place,
   * and drop only the rest. Refill closes the gap.
   */
  /**
   * Bring the queue back in line with the current plan, in BOTH membership and
   * order. Yahoo drafts from the top when your clock expires, so the order is not
   * cosmetic — it is the decision.
   *
   * Refills append, so after a few top-ups the queue holds the right players in
   * the wrong sequence. Rather than rebuild wholesale, keep the longest prefix
   * that already matches the plan and redo only the tail: if nothing has changed
   * the cost is zero clicks, and a single better player arriving costs one
   * removal and one add rather than eight of each.
   *
   * Entries the human added are never touched and never counted as out of place.
   */
  /**
   * Reorder the queue by DRAGGING, so nothing has to be removed to move it.
   *
   * Each queue row carries a dnd-kit sortable handle, and the page documents its
   * own keyboard protocol: space to lift, arrows to move, space to drop. Driving
   * that is far more reliable than synthesising a mouse drag, and it means order
   * and minimal-delta are no longer in conflict — before this, lifting one entry
   * meant removing and re-adding everything above it, which turned a rebuild into
   * "added 1, removed 8, kept 0".
   */
  const queueRows = () => [...document.querySelectorAll('.ys-player')]
    .filter((e) => /ADP:/.test(e.innerText));
  const dragHandle = (row) => {
    const li = row.closest('li');
    return li ? [...li.querySelectorAll('span')]
      .find((sp) => getComputedStyle(sp).cursor === 'grab') : null;
  };
  function pressKey(el, key, code) {
    for (const type of ['keydown', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }));
    }
  }
  async function moveQueueEntry(from, to) {
    if (from === to) return false;
    const handle = dragHandle(queueRows()[from]);
    if (!handle) return false;
    handle.focus();
    pressKey(handle, ' ', 'Space');                       // lift
    await sleep(200);
    const key = to > from ? 'ArrowDown' : 'ArrowUp';
    for (let i = 0; i < Math.abs(to - from); i++) {
      pressKey(document.activeElement || handle, key, key);
      await sleep(120);
    }
    pressKey(document.activeElement || handle, ' ', 'Space');   // drop
    await sleep(400);
    return true;
  }

  /**
   * Drag the queue into the plan's order. Selection sort: for each slot, find the
   * player who belongs there and drag him up. At most one move per slot, and no
   * player is ever removed — an entry that belongs in the queue stays in it.
   */
  /**
   * Drag one just-added player up to where the plan wants him, immediately.
   *
   * Yahoo appends, so every add lands at the bottom regardless of what it is
   * worth, and sorting afterwards is a separate pass that may never run: a live
   * round-1 fill appended J. Smith-Njigba at +67.8 in the same second the clock
   * started, and the reorder happened 36 seconds later, after the pick. Placing
   * each player as he arrives means an interruption leaves a correctly ordered
   * prefix rather than an unsorted queue.
   */
  async function placeInQueue(player, plan) {
    if (!CFG.ENFORCE_QUEUE_ORDER || myTurn()) return false;
    const want = plan.findIndex((p) => key(p.name, p.pos) === key(player.name, player.pos));
    if (want < 0) return false;
    const live = queueRows().map((r) => { const pl = parsePlayer(r); return pl ? key(pl.name, pl.pos) : null; });
    const at = live.lastIndexOf(key(player.name, player.pos));
    if (at < 0) return false;
    const to = Math.min(want, live.length - 1);
    if (at === to) return false;
    return moveQueueEntry(at, to);
  }

  async function reorderQueue(plan) {
    const planKeys = plan.map((p) => key(p.name, p.pos));
    let moves = 0;
    for (let i = 0; i < planKeys.length; i++) {
      if (myTurn()) { say('your turn started — stopping reorder'); break; }
      const live = queueRows().map((r) => { const pl = parsePlayer(r); return pl ? key(pl.name, pl.pos) : null; });
      if (i >= live.length) break;
      if (live[i] === planKeys[i]) continue;
      const at = live.indexOf(planKeys[i], i);
      if (at < 0) continue;                       // not in the queue; refill handles it
      if (await moveQueueEntry(at, i)) moves++;
    }
    if (moves) say(`reordered: ${moves} moved by drag, none removed`);
    return moves;
  }

  async function reconcileQueue(allowReorder) {
    const plan = planQueue(CFG.QUEUE_SIZE, []);
    if (!plan.length) return 0;
    const planKeys = plan.map((p) => key(p.name, p.pos));
    const keep = new Set(planKeys);

    // Only entries the ASSISTANT queued are ours to move; the human's stay put.
    const current = queueView().filter((pl) => pl && pl.pos && pl.pos !== '?');
    const ours = current;

    // MEMBERSHIP is reconciled; ORDER is not, unless asked for.
    //
    // Yahoo's queue has no reorder primitive, so putting an entry higher means
    // removing everything above it and adding it back. Enforcing full order made
    // the queue tear itself down and rebuild on almost every cycle — "dropped 6
    // (0 outranked, 6 out of order)" — for players that were all perfectly good.
    // The churn is far more disruptive than the imperfect order it fixes.
    // A settled queue is left ALONE.
    //
    // While the queue is full and it is not our turn, the only thing that should
    // change it is a queued player being drafted by someone else — then his slot
    // is refilled. Re-planning against the live board on every cycle meant the
    // queue was rewritten constantly for no gain, which is disruptive to watch and
    // pointless: the ranking barely moves between two consecutive picks.
    //
    // A full re-plan happens when our own pick changes what we need, which is the
    // one moment the queue's premise is genuinely invalid.
    // The DELTA, and nothing more: an entry goes only if the plan no longer wants
    // him. Most of a settled queue is still exactly right, and a rebuild should
    // leave those rows untouched.
    //
    // An entry is dropped for one reason only: the plan no longer wants him.
    // Being in the wrong SEAT is never a reason. Order is repaired by dragging,
    // in reorderQueue below — removing a player to re-add him lower is the one
    // thing the queue must never do.
    //
    // This used to doom every entry after the first out-of-order seat
    // (`doomedList = ours.slice(good)`), which quietly deleted players the plan
    // still wanted. They were not in `missing` — they were present when the delta
    // was computed — so nothing re-added them until the NEXT cycle. Live: the top
    // quarterback on the board was queued, evicted for sitting one seat low, and
    // was still gone when our turn arrived.
    const unavailable = (pl) => state.taken.has(key(pl.name, pl.pos));
    const wrong = allowReorder
      ? ours.filter((pl) => !keep.has(key(pl.name, pl.pos)))
      : ours.filter(unavailable);
    const good = ours.length - wrong.length;
    const present0 = new Set(current.map((pl) => key(pl.name, pl.pos)));
    const missing = plan.filter((pl) => !present0.has(key(pl.name, pl.pos)));
    if (!wrong.length && !missing.length) return 0;   // nothing to do; touch nothing

    /**
     * ADD FIRST, remove second.
     *
     * A rebuild can be cut short at any moment — the drafters ahead of us may be
     * autodrafting in a couple of seconds each — and whatever is in the queue when
     * our clock starts is what we have. Removing first spends that scarce time
     * making the queue WORSE: a live round-1 pick arrived with only three players
     * queued, because the rebuild was still clearing bad entries and had not got to
     * the additions. Adding first means an interruption leaves us with more good
     * players, never fewer.
     *
     * The queue briefly exceeds QUEUE_SIZE while both halves run. That is the point
     * of the trade, and the removals bring it back.
     */
    let added = 0, removed = 0;
    for (const p of missing) {
      if (myTurn()) { say('your turn started — stopping reconciliation'); break; }
      if (await toggleQueue(p, true)) {
        state.queue.push(p);
        state.ours.add(key(p.name, p.pos));
        saveOurs();
        added++;
        await placeInQueue(p, plan);          // put him where he belongs, now
      }
    }
    for (const victim of wrong) {
      if (myTurn()) { say('your turn started — stopping reconciliation'); break; }
      const vKey = key(victim.name, victim.pos);
      const gone = await removeFromQueue((pl) => key(pl.name, pl.pos) === vKey);
      if (gone.length) removed++;
    }
    if (added || removed) {
      say(`reconciled: added ${added}, removed ${removed}, kept ${good}`);
    }
    // Order is a drag, not a rebuild, so it costs nothing and runs whenever the
    // queue's CONTENTS changed — not only inside the rebuild window. Gating it on
    // the window meant a queue topped up between windows kept its insertion order:
    // the plan read Fannin 24.7, Pitts 20.5, Prescott 18.9, Kittle 15.4 while the
    // queue showed Pitts, Fannin, Kittle, Prescott. Reordering is a no-op when the
    // order is already right, so running it more often is free.
    if ((allowReorder || added || removed) && CFG.ENFORCE_QUEUE_ORDER && !myTurn()) {
      await reorderQueue(plan);
    }
    await clearFilters();
    return added + removed;
  }

  /** Available (undrafted, unrostered) count per position. */
  function availableByPos() {
    const mine = new Set(roster().map((h) => key(h.name, h.pos)));
    const out = {};
    for (const p of state.pool.values()) {
      if (state.taken.has(key(p.name, p.pos)) || mine.has(key(p.name, p.pos))) continue;
      out[p.pos] = (out[p.pos] || 0) + 1;
    }
    return out;
  }

  /**
   * Once half a position's pool has been drafted, re-read its top 100 so late
   * rounds still see a full board instead of the dregs of the original pull.
   */
  async function replenish() {
    const sel = posFilter();
    if (!sel) return 0;
    // "Half drafted" is relative to what that position actually yielded, not a flat
    // number. Only 32 defenses exist, so a fixed threshold of 50 made DEF
    // permanently "low" and re-read it every tick, flipping the filter constantly.
    const low = Object.entries(availableByPos()).filter(([pos, n]) => {
      if (state.exhausted[pos]) return false;
      const init = state.initialByPos[pos] || n;
      return n < init / 2;
    }).map(([pos]) => pos);
    if (!low.length) return 0;
    const prev = sel.value;
    let added = 0;
    for (const pos of low) {
      const opt = [...sel.options].find((o) => o.text.trim() === POS_LABEL[pos]);
      if (!opt) continue;
      const was = firstRowName();
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await waitForTable({ minRows: 1, changedFrom: was });
      let got = 0;
      for (const p of readRows()) if (!state.pool.has(p.id)) { state.pool.set(p.id, p); added++; got++; }
      if (got === 0) {
        state.exhausted[pos] = true;
        say(`replenish ${pos}: nothing new — exhausted, will not retry`);
      } else {
        state.initialByPos[pos] = availableByPos()[pos] || 0;
        say(`replenished ${pos} +${got} -> ${availableByPos()[pos] || 0} available`);
      }
    }
    sel.value = prev;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(800);
    return added;
  }

  async function refill() {
    const need = CFG.QUEUE_SIZE - queueCount();
    if (need <= 0) return;
    // The ranking now includes players already queued, so filter them here — this
    // is the step that actually adds, and it must not re-add what is present.
    const present = new Set(queueView().filter(Boolean).map((p) => key(p.name, p.pos)));
    // The SAME plan reconciliation uses — unseeded. Seeding from the live queue
    // produced a different plan to reconcile's, so the two disagreed permanently:
    // reconcile dropped six as "out of order", refill put them back in its own
    // order, and the pair oscillated every cycle.
    const full = planQueue(CFG.QUEUE_SIZE, []);
    const plan = full.filter((p) => !present.has(key(p.name, p.pos))).slice(0, need);
    if (!plan.length) return;
    say(`queue ${queueCount()}/${CFG.QUEUE_SIZE} — adding ${plan.length}`);
    for (const p of plan) {
      if (myTurn()) { say('your turn started — stopping refill'); return; }
      if (await toggleQueue(p, true)) {
        state.queue.push(p);
        state.ours.add(key(p.name, p.pos));
        saveOurs();
        say(`queued ${p.name} ${p.pos}-${p.team} val ${p.val} (${p.role}, po ${p.playoffMod}, bye ${p.byeMod})`);
        await placeInQueue(p, full);          // Yahoo appends; put him in rank order
      }
    }
  }

  // ---------------------------------------------------------------------------
  // One-time pool read
  // ---------------------------------------------------------------------------

  const POS_LABEL = { QB: 'Quarterbacks', RB: 'Running Backs', WR: 'Wide Receivers',
                      TE: 'Tight Ends', K: 'Kickers', DEF: 'Team Defenses' };
  const posFilter = () => [...document.querySelectorAll('select')]
    .find((s) => /All Positions/i.test(s.options?.[0]?.text || ''));

  const draftedToggle = () => [...document.querySelectorAll('button')]
    .find((b) => (b.innerText || '').trim() === 'Drafted');

  /**
   * Read the players who are already gone, for the baseline only.
   *
   * The baseline is the projection of a replacement-level starter, and it is a
   * property of the league's shape — so it must be computed over every player,
   * not just the undrafted ones. Arming mid-draft otherwise reads a pool with its
   * best hundred players missing: observed live at pick 111, the RB worst-starter
   * came out at 51.87 when the true figure was near 108, which makes every
   * remaining running back look like a franchise cornerstone.
   *
   * Yahoo's "Drafted" pill filters the table to exactly those players, with the
   * same projection column. Toggle it, sweep the positions, toggle it back.
   */
  async function readDraftedForBaseline() {
    const btn = draftedToggle();
    const sel = posFilter();
    if (!btn || !sel) { say('baseline: no Drafted toggle — baseline covers undrafted players only'); return true; }
    if (myTurn()) { say('baseline: your turn — deferring drafted-player read'); return false; }

    const prevPos = sel.value;
    const was = firstRowName();
    btn.click();
    await waitForTable({ minRows: 1, changedFrom: was });

    const seen = new Map();
    for (const label of CFG.POOL) {
      const opt = [...sel.options].find((o) => o.text.trim() === label);
      if (!opt) continue;
      const before = firstRowName();
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await waitForTable({ minRows: 1, changedFrom: before });
      for (const pl of readRows()) if (pl.proj > 0) seen.set(pl.id, { id: pl.id, pos: pl.pos, proj: pl.proj });
    }

    state.draftedPool = [...seen.values()];
    sel.value = prevPos;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    btn.click();                                  // back to the human's view
    await waitForTable({ minRows: 1 });
    const fresh = state.draftedPool.filter((x) => !state.pool.has(x.id)).length;
    say(`baseline: read ${state.draftedPool.length} from the Drafted view, ${fresh} not already in the pool`);
    return true;
  }

  async function readPool() {
    const sel = posFilter();
    const prev = sel?.value;
    for (const label of CFG.POOL) {
      if (sel) {
        const opt = [...sel.options].find((o) => o.text.trim() === label);
        if (!opt) { say(`pool: no filter option "${label}"`); continue; }
        const was = firstRowName();
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await waitForTable({ minRows: 1, changedFrom: was });
      }
      // Retry: a read taken while the table is mid-render yields nothing, and a
      // silent zero here leaves the whole assistant inert with an empty pool.
      let rows = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        rows = readRows();
        if (rows.length) break;
        say(`pool: ${label} empty on attempt ${attempt} ` +
            `(table=${!!playerTable()} cols=${JSON.stringify(columns())})`);
        await sleep(1200);
      }
      let added = 0;
      for (const p of rows) if (!state.pool.has(p.id)) { state.pool.set(p.id, p); added++; }
      say(`pool: ${label} +${added}`);
    }
    if (sel && prev !== undefined) {
      sel.value = prev;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(800);
    }
    // Verification pass: a position that came back nearly empty was read while the
    // table was churning, not because the players do not exist. Re-read those once.
    const counts = () => [...state.pool.values()].reduce((a, p) => (a[p.pos] = (a[p.pos] || 0) + 1, a), {});
    const thin = Object.entries({ QB: 20, RB: 20, WR: 20, TE: 20, K: 10, DEF: 10 })
      .filter(([pos, min]) => (counts()[pos] || 0) < min)
      .map(([pos]) => POS_LABEL[pos]);
    if (thin.length && sel) {
      say(`pool: thin after first pass (${thin.join(', ')}) — re-reading`);
      for (const label of thin) {
        const opt = [...sel.options].find((o) => o.text.trim() === label);
        if (!opt) continue;
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(1800);
        let added = 0;
        for (const p of readRows()) if (!state.pool.has(p.id)) { state.pool.set(p.id, p); added++; }
        say(`pool: ${label} re-read +${added}`);
      }
      if (prev !== undefined) {
        sel.value = prev;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(800);
      }
    }
    say(`pool read complete: ${state.pool.size} — ${JSON.stringify(counts())}`);
  }

  /** The self-scoring record: every horizon reached, predicted against actual. */
  window.__floorScore = () => state.realised.map((r) => ({
    span: `${r.from}-${r.target}`, targetRound: r.round, lateBy: r.lateBy,
    floorErr: r.err, mixPredicted: r.predictedMix, mixActual: r.actualMix, mixErr: r.mixErr,
    predicted: r.predicted, actual: r.actual,
  }));

  window.__queueDump = () => {
    const ranked = state.armed ? rankAvailable() : [];
    return {
      generatedAt: new Date().toISOString(),
      config: CFG,
      teamContextLoaded: !!window.YS_TEAM_CONTEXT,
      round: roundNow(),
      queueCount: queueCount(),
      myTurn: myTurn(),
      roster: roster(),
      rosterSize: rosterSize(),
      poolSize: state.pool.size,
      poolByPos: [...state.pool.values()].reduce((a, p) => (a[p.pos] = (a[p.pos] || 0) + 1, a), {}),
      takenCount: state.taken.size,
      picksSeen: [...state.seenPicks].sort((a, b) => a - b),
      queue: state.queue.map((q) => `${q.name} ${q.pos}`),
      top25: ranked.slice(0, 25).map((p) => ({
        name: p.name, pos: p.pos, team: p.team, bye: p.bye, proj: p.proj, adp: p.adp,
        raw: p.raw, val: p.val, role: p.role, tier: p.tier, sortVal: p.sortVal,
        depthMult: p.depthMult, playoffMod: p.playoffMod, byeMod: p.byeMod,
      })),
      pool: [...state.pool.values()].map(({ row, ...p }) => p),
      log: LOG,
    };
  };

  // The autopick dialog must be gone before the next pick, so it cannot wait for
  // the tick — a 2.5s poll plus render lag is far too slow in practice.
  const dialogObserver = new MutationObserver(() => ensureLiveDrafting());
  dialogObserver.observe(document.body, { childList: true, subtree: true });

  /**
   * Write the whole preprocessed state to a file. The pool lives only in the page,
   * so without this the only way to inspect it is to print it — which is both
   * slow and lossy. Downloads land in your browser's download directory.
   *
   *   window.__saveDump()            -> ys-dump-<round>.json
   *   window.__saveDump('pool.csv')  -> CSV of the pool only
   */
  window.__saveDump = (filename) => {
    const d = window.__queueDump();
    const csv = /\.csv$/i.test(filename || '');
    const body = csv
      ? ['name,pos,team,proj,adp,bye']
          .concat(d.pool.map((p) => [p.name, p.pos, p.team, p.proj, p.adp, p.bye]
            .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))).join('\n')
      : JSON.stringify(d, null, 2);
    const name = filename || `ys-dump-r${d.round || 0}.json`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: csv ? 'text/csv' : 'application/json' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    say(`saved ${name} (${d.poolSize} players, ${body.length} bytes)`);
    return name;
  };

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------

  let busy = false;
  async function tick() {
    if (busy || complete()) return;
    busy = true;
    try {
      ensureLiveDrafting();

      // An empty pool at any point means the assistant is inert — no ranking, no
      // refill, nothing to autopick from. Regenerate rather than idling.
      if (state.armed && state.pool.size === 0) {
        say('player pool is empty — regenerating');
        state.armed = false;
      }

      if (!state.armed) {
        if (!playerTable()) return;          // room not up yet
        await readPool();
        if (!state.pool.size) { say('pool came back empty — not arming, will retry'); return; }
        loadOurs();
        syncLeagueShape();               // slot from the URL, before anything uses it
        // If the drafted read had to be deferred — it clicks around the player
        // table, so it never runs during your turn — the baseline waits with it.
        // Computing now would fix a value derived from a pool missing every
        // drafted player, which is the exact error the read exists to fix, and the
        // baseline is computed once so there would be no second chance. Until it
        // lands, ranking falls back to the ADP survival model.
        state.baselinePending = !(await readDraftedForBaseline());
        if (!state.baselinePending && !state.teamsConfirmed) {
          say('baseline: league size not confirmed yet — waiting rather than fixing it wrong');
        }
        if (!state.baselinePending && state.teamsConfirmed) {
          computeBaseline();
          // Seed the floors immediately, so nothing is ever valued without them.
          await ensureProjection(draftPosition().overall, true);
        }
        state.initialByPos = Object.assign({}, availableByPos());
        state.lastRoster = roster().length;
        state.armed = true;
      }

      // Retry a deferred drafted read as soon as the turn is over, and compute the
      // baseline as soon as the league shape is confirmed. Both are one-shot.
      if (state.baselinePending && !myTurn()) {
        if (await readDraftedForBaseline()) state.baselinePending = false;
      }
      if (!state.baselinePending && !state.baselineDone) {
        syncLeagueShape();
        if (state.teamsConfirmed) {
          computeBaseline();                           // the one and only computation
          await ensureProjection(draftPosition().overall, true);
        }
      }

      scoreRealisedFloors();                 // grade past projections against reality
      observeShape();                        // narrow league size from the header
      foldPicks();                           // cheap header read, every tick

      // Your clock, your pick — the tick does nothing during your turn. The
      // last-second safety net runs on its own timer, because this one can be
      // busy inside a refill for ten seconds or more.
      if (myTurn()) return;

      const rc = roster().length;
      const weDrafted = rc > state.lastRoster;
      const short = queueCount() < CFG.QUEUE_SIZE;


      // Reading the queue's CONTENTS means selecting the Queue tab, and reading
      // the picks feed means selecting Picks — so doing both every cycle flips the
      // left panel back and forth continuously, which is horrible to watch and
      // buys nothing. The queue's SIZE comes from the tab badge without selecting
      // anything, and while the queue is full there is nothing to decide.
      //
      // So: a full queue, no pick of ours, and no rebuild due means this tick does
      // nothing at all.
      const queueFull = queueCount() >= CFG.QUEUE_SIZE;

      const here = draftPosition().overall;
      const away = picksUntilOurTurn(here);
      const turn = ourNextPickAfter(here);
      const window = Math.max(1, Math.floor(CFG.QUEUE_SIZE / 2));

      /**
       * A full rebuild happens ONCE per turn, a few picks before we are on the
       * clock — not on a timer, and not after every pick.
       *
       * Rebuilding late is what makes it worth doing at all: the projection and
       * the queue then reflect the picks that just happened, so a run on a
       * position is priced in. Rebuilding early, or repeatedly, spends a lot of
       * clicking to arrive at the same answer against staler information.
       *
       * Back-to-back picks are deliberately excluded. When our next two picks sit
       * within the same window there is no chance to rebuild usefully between
       * them, so we build once, before the first, and leave it.
       */
      const dueForRebuild = away <= window
        && state.lastFillTurn !== turn
        && !(state.lastFillTurn && turn - state.lastFillTurn <= window);

      // Would ensureProjection actually recompute? Only then is the picks feed
      // worth reading; "within three picks of our turn" stays true for several
      // consecutive ticks and used to re-read it on every one of them.
      const needProjection = away <= CFG.PROJECT_AT_PICKS_AWAY
        && (!state.proj || state.proj.turn !== turn);

      if (!weDrafted && !dueForRebuild && !needProjection && queueFull
          && !(state.proj && state.proj.turn !== state.lastProjApplied)) {
        state.working = false;
        return;                                  // settled: touch nothing
      }

      // The picks feed feeds the projection, which feeds the rebuild — so refresh
      // it when either is about to run. A projection once ran with teamRosters
      // empty and spent 29 simulated picks on 11 kickers and 11 defenses.
      if (weDrafted || dueForRebuild || needProjection) await syncPicksFromPanel();

      // Now read the queue itself — we are going to act on it.
      await syncQueue();

      // Projects only when close to our turn; a no-op otherwise.
      await ensureProjection(here);

      // New floors reprice EVERY queued player, not just the ones we might add, so
      // a fresh projection is itself a reason to recompute the queue and reorder
      // it. Without this the queue kept an order derived from floors that had
      // since been replaced — the values on screen were current while the sequence
      // was not.
      const freshFloors = state.proj && state.proj.turn !== state.lastProjApplied;
      if (freshFloors) state.lastProjApplied = state.proj.turn;

      // Nothing is queued before the first projection exists. Ranking without
      // floors falls back to the ADP model, which misprices kickers badly.
      if (!state.proj) { state.working = false; return; }

      if (weDrafted) state.lastRoster = rc;

      // Outside the rebuild window the queue is left alone entirely, apart from
      // replacing players who have actually been drafted — that top-up is handled
      // by refill below. This is what keeps the queue still.
      if (dueForRebuild) {
        state.lastFillTurn = turn;
        say(`rebuild window: ${away} picks until pick ${turn}`);
      }
      // A full recompute — membership and order — when the rebuild window opens or
      // when new floors land, since either invalidates the queue's ordering.
      await reconcileQueue(dueForRebuild || freshFloors);

      // Flag the overlay while we click around the queue UI, so the human knows to
      // keep hands off rather than fighting us for the mouse.
      state.working = true;
      try {
        await withPlayersTab(async () => {
          await pruneQueue();
          await replenish();
          if (queueCount() < CFG.QUEUE_SIZE) { await refill(); await clearFilters(); }
        });
        // refill appends, so anything it added is sitting at the bottom regardless
        // of what it is worth. Put the queue back in order once it is done.
        if (CFG.ENFORCE_QUEUE_ORDER && !myTurn()) {
          const plan = planQueue(CFG.QUEUE_SIZE, []);
          if (plan.length) await reorderQueue(plan);
        }
      } finally { state.working = false; }

      try { localStorage.setItem('ys_dump', JSON.stringify(window.__queueDump())); } catch (e) {}
    } catch (e) {
      say(`ERROR ${e.message}`);
    } finally {
      busy = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Overlay (optional, read-only)
  // ---------------------------------------------------------------------------


  /**
   * Shows what is ACTUALLY in the queue, and explains the number next to each
   * player. Deliberately does NOT repeat whose pick it is or the round — Yahoo
   * already shows both, and a second copy just goes stale.
   */
  /**
   * A strip across the bottom of the centre table showing the projected floors —
   * the single set of numbers every valuation now rests on.
   *
   * Shows the NEAREST horizon still ahead of us: floors are projected forward, so
   * among the horizons we hold, the lowest one still in the future is the one
   * bearing on the decision in hand. Older horizons the draft has already passed
   * are no longer answering a live question.
   */
  let floorsEl = null;
  /**
   * Score each projection against what actually happened.
   *
   * When the draft reaches a pick some earlier projection targeted, record the
   * best player still available at each position and compare it with what that
   * projection predicted would be there. Measured AT the target, not whenever we
   * next look — reading late understates every floor, because more players have
   * gone, and that alone made a running-back error look like -19.8 when the
   * horizon before it had been exact.
   *
   * The interesting question is not whether a position is over- or under-valued
   * on average but WHERE in the draft it goes wrong, so each row keeps the round
   * it was projected from and the round it landed in.
   */
  function scoreRealisedFloors() {
    if (!state.floors || !state.floors.size) return;
    const here = draftPosition().overall;
    const mine = new Set(roster().map((r) => key(r.name, r.pos)));

    for (const [target, byPos] of state.floors) {
      if (here < target) continue;                       // not reached yet
      if (state.realised.some((r) => r.target === target)) continue;   // already scored

      // The picks PANEL lags our own clock, and the tick does not sync it while
      // our turn is running (Q8). Scoring fires the moment `here` reaches the
      // horizon — which is our own turn — so it used to grade against a feed that
      // had not caught up, and every number came out wrong in a predictable
      // direction: `actualMix` counted only the handful of picks read so far, and
      // `best[pos]` still counted drafted players as available, inflating the
      // floor error. Live at pick 42 it scored 3 of the 29 picks in the window and
      // reported mix QB -1, RB -12, WR -7, TE -4; the same horizon against the
      // complete feed was QB 0, RB -2, WR +4, TE -1 — a good forecast graded as a
      // disaster.
      //
      // Wait until the panel has been read through the horizon. seenPickNos only
      // ever grows, so this cannot stall; the delay lands in `lateBy`, which is
      // already reported. Requiring pickPos to be COMPLETE would stall, because
      // players inferred as drafted ("has no row") never get a pick number.
      const syncedTo = state.seenPickNos && state.seenPickNos.size
        ? Math.max(...state.seenPickNos) : -Infinity;
      if (syncedTo < target) continue;

      const best = {};
      for (const p of state.pool.values()) {
        const k = key(p.name, p.pos);
        if (state.taken.has(k) || mine.has(k)) continue;
        if (!best[p.pos] || p.proj > best[p.pos]) best[p.pos] = p.proj;
      }
      const predicted = {}, actual = {}, err = {};
      for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
        const pv = byPos[pos] && byPos[pos].length ? byPos[pos][0].proj : null;
        const av = best[pos] ?? null;
        predicted[pos] = pv; actual[pos] = av;
        err[pos] = (pv != null && av != null) ? +(av - pv).toFixed(1) : null;
      }
      // How the predicted POSITIONAL BREAKDOWN compares with what was really
      // taken over the same span of picks. The floors are only as good as this.
      const meta = state.floorMeta.get(target) || {};
      const actualMix = {};
      if (meta.from != null) {
        for (const [overall, pos] of Object.entries(state.pickPos)) {
          const n = +overall;
          if (n >= meta.from && n < target) actualMix[pos] = (actualMix[pos] || 0) + 1;
        }
      }
      const mixErr = {};
      for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
        const pv = (meta.goneByPos || {})[pos] || 0;
        const av = actualMix[pos] || 0;
        if (pv || av) mixErr[pos] = av - pv;
      }

      state.realised.push({
        target, round: Math.ceil(target / CFG.TEAMS),
        scoredAt: here, lateBy: here - target,
        from: meta.from ?? null,
        predicted, actual, err,
        predictedMix: meta.goneByPos || {}, actualMix, mixErr,
      });
      const line = Object.entries(err)
        .filter(([, v]) => v !== null)
        .map(([pos, v]) => `${pos} ${v > 0 ? '+' : ''}${v}`).join(', ');
      const mixLine = Object.entries(mixErr)
        .map(([pos, v]) => `${pos} ${v > 0 ? '+' : ''}${v}`).join(', ');
      say(`scored R${Math.ceil(target / CFG.TEAMS)} horizon (pick ${target}, ` +
          `${here - target} late): floors ${line} | mix ${mixLine || 'exact'}`);
    }
  }

  function renderFloors() {
    if (!CFG.SHOW_FLOORS) { if (floorsEl) { floorsEl.remove(); floorsEl = null; } return; }
    const floors = state.floors;
    if (!floors || !floors.size) {
      if (floorsEl) floorsEl.style.display = 'none';
      return;
    }

    // Show the floors CURRENTLY driving valuation — the latest projection — not the
    // nearest horizon still ahead. Those differ: at pick 37 the horizons held were
    // 34, 51 and 62, the strip showed 34 because it was the nearest ahead, and the
    // bar in use was 62. A strip that reports a horizon nothing is using is worse
    // than no strip.
    const at = state.proj ? state.proj.target : [...floors.keys()].sort((a, b) => b - a)[0];
    const byPos = (state.proj && state.proj.byPos) || floors.get(at);
    if (!byPos || at == null) return;

    if (!floorsEl) {
      floorsEl = document.createElement('div');
      floorsEl.style.cssText =
        'position:fixed;z-index:2147483646;pointer-events:none;' +
        'font:600 11.5px/1 ui-monospace,Menlo,monospace;letter-spacing:.02em;' +
        'background:rgba(17,19,24,.94);color:#e9edf2;border-radius:6px;' +
        'padding:7px 12px;display:flex;gap:14px;align-items:center;' +
        'box-shadow:0 4px 18px rgba(0,0,0,.32);white-space:nowrap;overflow:hidden';
      document.body.appendChild(floorsEl);
    }
    floorsEl.style.display = 'flex';

    const round = Math.ceil(at / CFG.TEAMS);
    const live = bestAvailableNow();
    const cells = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((pos) => {
      const raw = byPos[pos] && byPos[pos].length ? byPos[pos][0].proj : null;
      const now = live[pos];
      const v = (raw === null) ? null : (now === undefined ? raw : Math.min(raw, now));
      const stale = raw !== null && now !== undefined && raw > now + 0.05;
      return `<span style="color:#7c8894">${pos}</span> ` +
             `<span${stale ? ' style="color:#e08a6e"' : ''}>${v === null ? '—' : v.toFixed(1)}</span>`;
    }).join('<span style="color:#39414d">|</span>');
    // The FLEX floor — the highest of RB/WR/TE — is the bar every flex-eligible
    // BACKUP is measured against (V14), so it belongs on screen beside the
    // per-position floors that starters use.
    let flex = null;
    for (const q of FLEX_POS) {
      const l = byPos[q] && byPos[q].length ? byPos[q][0].proj : null;
      const now = live[q];
      const v = l === null ? null : (now === undefined ? l : Math.min(l, now));
      if (v !== null && (flex === null || v > flex)) flex = v;
    }
    floorsEl.innerHTML =
      `<span style="color:#d99b52">FLOORS R${round}</span>` +
      `<span style="color:#7c8894">pick ${at}</span>` + cells +
      `<span style="color:#39414d">|</span>` +
      `<span style="color:#d99b52">FLEX</span> ` +
      `<span>${flex === null ? '—' : flex.toFixed(1)}</span>`;

    // Anchored to the bottom of the WINDOW, not the table. Tying it to the table
    // meant filtering the player list to a single row jumped the strip halfway up
    // the screen.
    const w = floorsEl.offsetWidth || 520;
    floorsEl.style.left = `${Math.max(8, Math.round((innerWidth - w) / 2))}px`;
    floorsEl.style.bottom = '14px';
    floorsEl.style.top = 'auto';
  }



  const timer = setInterval(tick, CFG.TICK_MS);
  // Own timer: the overlay is read-only and must never be starved by a slow tick —
  // refills, filter switches and searches all await.
  /**
   * The last-second pick runs on its OWN fast timer, never inside the main tick.
   * A refill involves searches, filter switches and clearFilters and can occupy
   * the tick for ten seconds or more; when a turn began during one, the tick was
   * busy and the clock ran to zero unchecked. This loop only watches, so it
   * cannot be starved.
   */
  let autopickTried = false;
  let pairTried = false;
  let pairTrace = null;
  let watchTrace = null;
  const autopickTimer = setInterval(() => {
    try {
      if (complete()) return;
      if (!myTurn()) {
        autopickTried = false; pairTried = false; watchTrace = null;
        state.turnRosterCounts = null;
        return;
      }
      // First tick of this turn: remember what the roster looked like before we
      // picked, so a pick made during the turn is detectable.
      if (!state.turnRosterCounts) {
        const c = {};
        for (const r of roster()) c[r.pos] = (c[r.pos] || 0) + 1;
        state.turnRosterCounts = c;
      }
      const left = secondsLeft();

      // Back-to-back picks: on the SECOND of the pair, force a different position
      // than the first. Fires at PAIR_SPLIT_AT_SECONDS regardless of whether the
      // ordinary last-second pick is enabled.
      const firstPos = pairFirstPosition();
      if (firstPos && pairTrace !== firstPos) {
        pairTrace = firstPos;
        say(`back-to-back: already took ${firstPos} this turn — will split at ` +
            `${CFG.PAIR_SPLIT_AT_SECONDS}s`);
      }
      if (firstPos && !pairTried && left !== null && left <= CFG.PAIR_SPLIT_AT_SECONDS) {
        pairTried = true;
        draftDifferentPosition(firstPos);
        return;
      }

      if (!CFG.AUTOPICK_AT_SECONDS) return;
      if (autopickTried) return;
      // Trace once per second while it is our turn: without this, a non-firing
      // autopick is indistinguishable from a watcher that never ran at all.
      if (watchTrace !== left) { watchTrace = left; say(`turn: ${left}s left (fire at ${CFG.AUTOPICK_AT_SECONDS})`); }
      if (left === null || left > CFG.AUTOPICK_AT_SECONDS) return;
      autopickTried = true;
      draftQueueTop();
    } catch (e) { say(`autopick watcher: ${e.message}`); }
  }, 400);

  /**
   * Write each entry's numbers into Yahoo's own queue rows: GAIN, then the playoff
   * delta when non-zero. Numbers only — the row is narrow and the name is there.
   * React re-renders these rows freely, so the tag is re-applied every pass.
   */
  function annotateQueue() {
    if (!CFG.ANNOTATE_QUEUE) return;
    if (!/^Queue/i.test(activeTab())) return;
    const valued = queueView();
    for (const el of [...document.querySelectorAll('.ys-player')].filter((e) => /ADP:/.test(e.innerText))) {
      const p = parsePlayer(el);
      if (!p) continue;
      const v = (p.id && valued.find((x) => x.id === p.id))
        || valued.find((x) => x.name === p.name && x.pos === p.pos);
      let tag = el.querySelector(':scope > .ys-assist');
      if (!tag) {
        tag = document.createElement('span');
        tag.className = 'ys-assist';
        tag.style.cssText = 'display:block;pointer-events:none;font:600 10.5px/1.3 ' +
          'ui-monospace,Menlo,monospace;letter-spacing:.02em;margin-top:1px';
        el.appendChild(tag);
      }
      if (!v || !Number.isFinite(v.val)) {
        tag.textContent = v && v.val === Infinity ? 'MUST' : '';
        tag.style.color = '#8b96a3';
        continue;
      }
      const sched = Number.isFinite(v.playoffDelta) && Math.abs(v.playoffDelta) >= 0.05
        ? `  ${v.playoffDelta > 0 ? '+' : '−'}${Math.abs(v.playoffDelta).toFixed(1)}` : '';
      tag.textContent = (v.val > 0 ? '+' : '') + v.val.toFixed(1) + sched;
      tag.style.color = v.val > 0 ? '#1a7f4b' : '#8b96a3';
    }
  }

  let paintErr = null;
  const overlayTimer = setInterval(() => {
    try { renderFloors(); annotateQueue(); }
    catch (e) {
      // Never swallow silently: a throw here previously left the overlay blank
      // with no explanation anywhere.
      if (paintErr !== e.message) { paintErr = e.message; say(`paint error: ${e.message}`); }
    }
  }, 1000);
  window.__queueStop = () => { clearInterval(timer); clearInterval(overlayTimer); clearInterval(autopickTimer);
    if (floorsEl) { floorsEl.remove(); floorsEl = null; }
    dialogObserver.disconnect();
    document.querySelectorAll('.ys-assist').forEach((e) => e.remove());   // leave the queue clean
    say('stopped'); };
  window.__queueState = state;
  window.__queueCfg = CFG;          // for diagnostics
  say(`armed — ${CFG.DRY_RUN ? 'DRY RUN' : 'LIVE'}, target ${CFG.QUEUE_SIZE}, slot ${CFG.SLOT}`);
})();
