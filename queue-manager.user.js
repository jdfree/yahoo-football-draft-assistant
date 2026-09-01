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
    WEIGHT_STARTER: 1.0,
    WEIGHT_FLEX: 0.9,
    WEIGHT_RESERVE: 0.2,

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
    SHOW_OVERLAY: false,
    OVERLAY_CORNER: 'bottom-right',   // vertical placement only: 'top…' or 'bottom…'
    // Distance from the right edge, used only if the roster panel cannot be
    // measured. Normally the overlay auto-positions just left of your roster.
    OVERLAY_RIGHT_OFFSET: 330,
    OVERLAY_ROWS: 6,

    // --- 5. last-second pick ------------------------------------------------
    // Seconds left on YOUR clock at which the manager drafts the top of the queue
    // itself. 0 = never; let the clock expire and Yahoo take the queue top.
    //
    // Setting this above 0 is not just convenience: Yahoo switches your team into
    // autopick mode whenever a timer actually expires, and every later pick is
    // then made for you. Picking at 2 seconds means the timer never expires, so
    // that never triggers.
    AUTOPICK_AT_SECONDS: 0,

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
    // On, but it only ever runs when a new round of projected floors lands, or
    // right after our own pick. That gate is what makes it affordable: Yahoo has
    // no reorder primitive, so a misplaced entry costs a remove-and-re-add of
    // everything below it, and reconciling on every tick tore the queue down and
    // rebuilt it continuously. Once per round it is a single tidy-up.
    //
    // It matters because Yahoo drafts from the TOP of the queue when your clock
    // expires. Left alone, insertion order persists: a live queue led with a
    // defense worth +3.5 and a kicker worth +2.1 ahead of a back worth +91.8.
    ENFORCE_QUEUE_ORDER: true,

    // How many rounds ahead the projection looks. Deciding in round 10 is measured
    // against the board expected at our round-12 pick. Two is the point at which a
    // position can realistically be stripped: comparing against our very next pick
    // understates the cost of passing, because we rarely come back to a position
    // one pick later.
    HORIZON_ROUNDS: 2,

    // --- replacement horizon -------------------------------------------------
    // How many rounds to assume a position goes undrafted if you pass on it now.
    // Comparing against "what could I get one pick later" understates the cost of
    // skipping: you rarely come back to a position on your very next pick. At 2,
    // replacement level is what would survive two full rounds of attrition.
    SKIP_ROUNDS: 2,

    // How much ADP scatters, in picks. A hard cutoff treats ADP as a promise —
    // "ADP 130 will definitely last to pick 129" — when it is only an average.
    // The top-projected player at a position is precisely who a value-drafter
    // reaches for, so he is far likelier to go early than his ADP suggests.
    // Larger values assume more randomness in the room.
    ADP_SIGMA: 12,

    // --- backup depth at RB/WR ----------------------------------------------
    // Injuries and bye-week holes are needed far more often at running back and
    // receiver than at quarterback or tight end, where one starter usually
    // suffices. This multiplies the RANKING weight of a bench-tier RB or WR so
    // depth there wins ties against a bench QB or TE of similar raw value.
    //
    // It deliberately does NOT change the displayed GAIN — the overlay keeps
    // showing the honest points-over-replacement figure. Only the ordering moves.
    BACKUP_RB_WR_WEIGHT: 3,

    // How much to inflate an RB's or WR's PROJECTION when he is being valued as a
    // bench player, as a fraction. Bench depth matters more at those positions:
    // you start two of each plus a flex, and they miss time most often.
    //
    // This is deliberately a boost to the projection rather than a multiplier on
    // the surplus. Multiplying the surplus inverts once the surplus goes negative,
    // which is where most bench players sit by the late rounds, and it pushed RB
    // and WR down the queue instead of up. It never touches the displayed number —
    // only the ordering.
    BENCH_RB_WR_BOOST: 0.10,

    // How many rounds from the end an OPPONENT is assumed to consider a kicker or
    // defense. A kicker scores positive against baseline from round one, so
    // without this the simulation drafts them constantly and never touches the
    // skill positions that are actually disappearing.
    OPPONENT_LATE_K_DEF: 2,

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
    human: new Set(),       // entries seen ARRIVING without us; never reordered
    queueSynced: false,     // has the queue been read once? see syncQueue
    lastReconciledRound: null,  // reorder once per round of floors, not per pick
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
  const isHuman = (p) => state.human.has(key(p.name, p.pos));

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
    const all = [...state.baselinePool].sort((a, b) => b.proj - a.proj);
    const need = {};
    for (const [pos, n] of Object.entries(CFG.STARTERS)) need[pos] = n * CFG.TEAMS;
    let flexLeft = CFG.FLEX * CFG.TEAMS;

    const starters = {};
    const take = (p) => { (starters[p.pos] = starters[p.pos] || []).push(p.proj); };

    for (const p of all) {                       // dedicated slots, best first
      if ((need[p.pos] || 0) > 0) { need[p.pos]--; take(p); p._starter = true; }
    }
    for (const p of all) {                       // then flex, from what is left
      if (p._starter || flexLeft <= 0) continue;
      if (FLEX_POS.includes(p.pos)) { flexLeft--; take(p); p._starter = true; }
    }
    for (const p of all) delete p._starter;

    const baseline = {};
    for (const [pos, list] of Object.entries(starters)) baseline[pos] = Math.min(...list);
    state.baseline = baseline;
    state.baselineDone = true;
    say(`baseline (worst starter, fixed for the draft): ${JSON.stringify(baseline)}`);

    // Self-check. A corrupt pool does not make the baseline throw, it just makes it
    // quietly wrong — a duplicated pool once put RB at 151 instead of 108 and
    // nothing complained. The count of players at or above the baseline must match
    // the number of starting slots at that position, so verify it and say so.
    for (const [pos, list] of Object.entries(starters)) {
      const atOrAbove = state.baselinePool.filter((p) => p.pos === pos && p.proj >= baseline[pos]).length;
      if (Math.abs(atOrAbove - list.length) > 2) {
        say(`baseline WARNING ${pos}: ${atOrAbove} players at or above ${baseline[pos]} ` +
            `but only ${list.length} starting slots — pool likely duplicated or mis-read`);
      }
    }
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
   * The "subsequent pick": the one AFTER our next pick, unless our next two are
   * consecutive, in which case it is the one after that pair. This is the horizon
   * over which a position can realistically be stripped.
   *
   * It is anchored to the pick we are ABOUT TO MAKE, not to whatever pick the room
   * happens to be on. Deciding anywhere in round 10 looks to our round-12 pick;
   * deciding in round 1 looks to round 3.
   *
   * Anchoring to the room's current pick made the answer depend on WHEN in the
   * round it was computed. While another team was picking in round 10,
   * ourNextPickAfter returned our own round-10 pick as "next" and the horizon came
   * out a round short at round 11; recomputed after our pick it gave round 12. The
   * shorter horizon understates how far a position gets stripped, and running backs
   * suffer most — a QB once topped the round-1 queue on a 28-point edge measured
   * against round 2, while the backs' real cost against round 3 went unmeasured.
   */
  /** Our pick in a given round, in a snake. */
  function ourPickInRound(round) {
    const T = CFG.TEAMS;
    return (round % 2 === 1) ? (round - 1) * T + CFG.SLOT : round * T - CFG.SLOT + 1;
  }
  function subsequentPick(currentPick) {
    const imminent = ourNextPickAfter(currentPick);      // the pick in hand
    const round = Math.ceil(imminent / CFG.TEAMS);
    // Never look past the end of the draft. Unclamped, the last rounds targeted
    // picks that do not exist — 216 in a 210-pick draft — and the simulation then
    // removed players for picks nobody ever makes, depressing those floors.
    const lastPick = CFG.TEAMS * rosterSize();
    return Math.min(ourPickInRound(round + CFG.HORIZON_ROUNDS), lastPick);
  }

  /** Starting slots a roster still has open, as positions a pick could fill. */
  function openSlots(roster) {
    const count = (pos) => roster.filter((r) => r.pos === pos).length;
    const open = new Set();
    let flexUsed = 0;
    for (const pos of FLEX_POS) flexUsed += Math.max(0, count(pos) - (CFG.STARTERS[pos] || 0));
    for (const [pos, n] of Object.entries(CFG.STARTERS)) if (count(pos) < n) open.add(pos);
    if (flexUsed < CFG.FLEX) for (const pos of FLEX_POS) open.add(pos);
    return open;
  }

  /**
   * What one team would take, given its roster and who is left. Models a rational
   * drafter: fill starting slots first by surplus over a replacement starter, then
   * draft for depth with RB/WR weighted up.
   */
  function projectedChoice(roster, pool, pickNo) {
    const base = state.baseline || {};
    const open = openSlots(roster);

    // A team will not take a third player at one position sharing a bye week.
    const byeBlocked = (p) => p.bye != null &&
      roster.filter((r) => r.pos === p.pos && r.bye === p.bye).length >= 2;

    // Opponents do not draft kickers and defenses until the end, whatever the
    // surplus says, and modelling them as if they might is badly wrong: a kicker
    // scores positive against baseline from round one, so with any unfilled K or
    // DEF slot the model will happily take one. Left unchecked it drafted eleven
    // of each inside thirty picks. This is a claim about how opponents behave, not
    // about how we should — our own LATE_ONLY gate is separate and off by default.
    const roundOfPick = Math.ceil(pickNo / CFG.TEAMS);
    const lateEnough = roundOfPick > rosterSize() - CFG.OPPONENT_LATE_K_DEF;

    // Slots a team would actually fill right now. By the middle rounds most teams
    // have everything but a kicker and a defense left open, and those are the two
    // they will not take yet — so "still filling starters" has to mean starters
    // they would REALLY take. Without this those teams matched nothing at all and
    // drafted nobody: a 38-pick horizon simulated 2 picks and the floors barely
    // moved. A team in that position takes bench depth, which is what happens.
    const fillable = new Set([...open].filter((pos) =>
      lateEnough || (pos !== 'K' && pos !== 'DEF')));
    const fillingStarters = fillable.size > 0;

    let best = null, bestScore = -Infinity;
    for (const p of pool) {
      if (byeBlocked(p)) continue;
      if (!lateEnough && (p.pos === 'K' || p.pos === 'DEF')) continue;
      if (fillingStarters && !fillable.has(p.pos)) continue;
      if ((CFG.CAPS[p.pos] || 99) <= roster.filter((r) => r.pos === p.pos).length) continue;

      let score = p.proj - (base[p.pos] ?? p.proj);
      if (!fillingStarters && (p.pos === 'RB' || p.pos === 'WR')) score *= CFG.BACKUP_RB_WR_WEIGHT;
      if (score < 1) score = 1;                  // a pick happens regardless
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
  async function projectAvailability(currentPick) {
    if (!state.baseline) return null;
    const target = subsequentPick(currentPick);
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
      const choice = projectedChoice(rost, pool.filter((x) => !gone.has(x.id)), p);
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
  async function ensureProjection(currentPick) {
    const rd = roundNow();
    if (state.proj && state.proj.round === rd && state.proj.teams === CFG.TEAMS) return state.proj;
    if (!state.baseline) return null;
    const sim = await projectAvailability(currentPick);
    if (!sim) return null;
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
    state.proj = { round: rd, teams: CFG.TEAMS, target: sim.target, byPos,
                   from: currentPick, simulated: sim.simulated, goneByPos };
    const shown = Object.entries(byPos)
      .map(([pos, l]) => `${pos} ${l.length ? l[0].proj : '-'}`).join(', ');
    // Label with the round the horizon is anchored to — the round of the pick we
    // are about to make — not the room's current round; past our own pick in a
    // round those differ, and the log read "round 13" while measuring from 14.
    const anchor = Math.ceil(ourNextPickAfter(currentPick) / CFG.TEAMS);
    say(`projection from round ${anchor} (picks ${currentPick}-${sim.target}, ` +
        `${sim.simulated} simulated, gone ${JSON.stringify(goneByPos)}): ${shown}`);
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
      .filter((p) => !planned.has(p.id));

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

    // How many picks pass before we would realistically come back to a position.
    // Summing gapTo over successive rounds handles the snake: from any pick to the
    // same slot two rounds later is exactly 2 x TEAMS.
    let horizon = 0;
    for (let i = 0; i < Math.max(1, CFG.SKIP_ROUNDS); i++) horizon += gapTo(rd + i);

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

    /**
     * Probability a player is still on the board when we next consider his
     * position. ADP is a mean, not a guarantee, so this is a logistic curve
     * around the horizon rather than a step function: a player whose ADP sits
     * exactly at the horizon is a coin flip, not a certainty either way.
     */
    // Read the round's projection; ensureProjection computes it, off this path.
    const projected = state.proj && state.proj.round === roundNow() ? state.proj : null;

    const deadline = currentPick + horizon;
    // Our final pick of the draft, used for kickers and defenses.
    const endDeadline = currentPick + Math.max(1, size - have.length) * CFG.TEAMS;
    const survivesBy = (p, by) => {
      const a = effAdp.get(p.id) ?? by;
      return 1 / (1 + Math.exp((by - a) / Math.max(1, CFG.ADP_SIGMA)));
    };

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
    const replacement = (pos, exceptId) => {
      const l = byPos[pos].filter((p) => p.id !== exceptId);   // sorted by projection
      if (!l.length) return 0;
      // Kickers and defenses are measured against the END of the draft, not the
      // next couple of rounds — the real choice is "one now" versus "one with the
      // last pick". They use the SAME probabilistic machinery so everything stays
      // on one scale; only the deadline differs. Leaving them on a fixed
      // "twelve deep" rule while skill positions moved to expected replacement
      // made K and DEF look far worse than they are.
      // Preferred: what the simulation says is still there at our subsequent pick.
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
        const survivor = projected.byPos[pos].find((p) => p.id !== exceptId);
        if (survivor) return survivor.proj;
      }
      // Fallback while the simulation has no opinion (no baseline yet, or a
      // position it never reached): the ADP survival model.
      const by = (pos === 'K' || pos === 'DEF') ? endDeadline : deadline;
      let remaining = 1;          // chance everyone better has already gone
      let expected = 0;
      for (const p of l) {
        const sv = survivesBy(p, by);
        expected += p.proj * remaining * sv;
        remaining *= (1 - sv);
        if (remaining < 0.01) break;
      }
      // Whatever probability is left over means nobody useful survives.
      return expected + remaining * l[l.length - 1].proj;
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
      Math.max(...FLEX_POS.map((pos) => replacement(pos, exceptId)));

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
      const bar = role === 'flex' ? flexReplacement(p.id) : replacement(p.pos, p.id);

      // DISPLAYED value: the pure surplus, carrying no modifiers whatsoever.
      // Everything that shapes preference is applied below, to the sort key only,
      // so the number on screen always means one thing: points above what you
      // could get at this slot if you passed.
      const raw = p.proj - bar;

      const pm = playoffModifier(p.team);
      const bm = byeMultiplier(p, have);
      const teamMod = sameTeamMultiplier(p, have);

      /**
       * Bench depth at RB and WR is worth more than the surplus alone says: you
       * start two of each plus a flex, and they miss time most often, so a backup
       * there actually plays.
       *
       * The boost lands on the PROJECTION, not on the surplus. Scaling a surplus
       * breaks down precisely when it matters: by the late rounds nearly every
       * bench surplus is negative, and multiplying a negative by three pushed RB
       * and WR DOWN the queue — the reverse of the intent. Observed live at round
       * 10 with bench values of -0.61, -1.60 and -2.56. Adding to the projection
       * shifts the surplus up whatever its sign.
       */
      const benchBoost = (role === 'reserve' && (p.pos === 'RB' || p.pos === 'WR'))
        ? 1 + CFG.BENCH_RB_WR_BOOST : 1;
      const rankRaw = p.proj * benchBoost * teamMod - bar;
      const sortVal = rankRaw * weight * bm * pm;
      const playoffDelta = raw * (pm - 1);

      return { ...p, raw: +raw.toFixed(2), val: +raw.toFixed(2),
               playoffDelta: +playoffDelta.toFixed(2),
               tier: ROLE_TIER[role] ?? 2,
               sortVal: +sortVal.toFixed(2), depthMult: +benchBoost.toFixed(2), role,
               gated: isGated(p),
               playoffMod: +pm.toFixed(4), byeMod: +bm.toFixed(3), teamMod: +teamMod.toFixed(3),
               why: `${p.proj} - repl ${bar.toFixed(1)} = ${raw.toFixed(1)} shown;` +
                    ` rank x${weight}(${role}) x${pm.toFixed(3)}(po) x${bm.toFixed(2)}(bye)` +
                    (benchBoost !== 1 ? ` proj+${Math.round((benchBoost - 1) * 100)}%(bench)` : '') };
    // Rank by ROLE first, then by value inside the role.
    //
    // The backup RB/WR multiplier is meant to say that bench depth matters more at
    // RB and WR than at QB or TE — a comparison among BENCH players. Folded into
    // one flat sort it also let a backup outrank a player filling an empty starting
    // slot, because x3 against the x0.2 reserve weight collapses the configured
    // 5:1 starter-to-bench preference down to 1.67:1. That is what put backups
    // above receivers with visibly higher surplus while a starting WR slot sat
    // empty. Tiering keeps the multiplier doing its job without letting it
    // overturn the roster's actual needs, and it also makes the displayed value
    // monotonic within each tier, so the queue reads the way the numbers look.
    }).sort((a, b) => (a.tier - b.tier) || (b.sortVal - a.sortVal));
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

    const live = liveQueue() || [];

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
      for (const p of live) {
        if (!weQueued(p)) state.human.add(key(p.name, p.pos));
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
    const byKey = new Map(ranked.map((p) => [key(p.name, p.pos), p]));
    return saved.map((q) => byKey.get(key(q.name, q.pos))
      || Object.assign({}, q, { val: null }));
  }

  /**
   * How many queue slots one position may occupy. Keeping this below the queue
   * size guarantees the queue always offers a genuine alternative rather than
   * five variations on the same decision — if a run empties that position, the
   * rest of the queue is still useful.
   */
  const positionLimit = (pos, b2b) => {
    if (pos === 'K' || pos === 'DEF') return b2b ? 1 : 2;
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
        .filter((p) => (posCount[p.pos] || 0) < positionLimit(p.pos, b2b));
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
    const b2b = backToBack();
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
      if (seen[p.pos] > positionLimit(p.pos, b2b)) mark(p);
    }

    // Never remove what the human queued themselves.
    const yours = view.filter((p) => bad.has(`${p.name}|${p.pos}`) && isHuman(p));
    if (yours.length) {
      say(`leaving your own entries alone: ${yours.map((p) => p.name).join(', ')}`);
      yours.forEach((p) => bad.delete(`${p.name}|${p.pos}`));
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
  async function reconcileQueue(allowReorder) {
    const plan = planQueue(CFG.QUEUE_SIZE, []);
    if (!plan.length) return 0;
    const planKeys = plan.map((p) => key(p.name, p.pos));
    const keep = new Set(planKeys);

    // Only entries the ASSISTANT queued are ours to move; the human's stay put.
    const current = queueView().filter((pl) => pl && pl.pos && pl.pos !== '?');
    const ours = current.filter((pl) => !isHuman(pl));

    // MEMBERSHIP is reconciled; ORDER is not, unless asked for.
    //
    // Yahoo's queue has no reorder primitive, so putting an entry higher means
    // removing everything above it and adding it back. Enforcing full order made
    // the queue tear itself down and rebuild on almost every cycle — "dropped 6
    // (0 outranked, 6 out of order)" — for players that were all perfectly good.
    // The churn is far more disruptive than the imperfect order it fixes.
    let doomedList = ours.filter((pl) => !keep.has(key(pl.name, pl.pos)));
    let good = ours.length - doomedList.length;
    if (CFG.ENFORCE_QUEUE_ORDER && allowReorder) {
      good = 0;
      while (good < ours.length && good < planKeys.length
             && key(ours[good].name, ours[good].pos) === planKeys[good]) good++;
      doomedList = ours.slice(good);
    }
    const wrong = doomedList;
    if (!wrong.length) return 0;                  // nothing outranked: touch nothing
    const doomed = new Set(wrong.map((pl) => key(pl.name, pl.pos)));

    /**
     * Swap one at a time: remove a single entry, put its replacement in, then move
     * on. Removing everything first and refilling afterwards left the queue nearly
     * empty for as long as the rebuild took — a live round-2 rebuild was still
     * running when the round-3 pick arrived, and the queue had almost nothing in
     * it at exactly the moment it mattered. At worst this is one slot short for a
     * moment.
     */
    let swapped = 0;
    for (const victim of wrong) {
      if (myTurn()) { say('your turn started — stopping reconciliation'); break; }
      const vKey = key(victim.name, victim.pos);
      const gone = await removeFromQueue((pl) => !isHuman(pl) && key(pl.name, pl.pos) === vKey);
      if (!gone.length) continue;
      swapped++;
      const present = new Set(queueView().filter(Boolean).map((pl) => key(pl.name, pl.pos)));
      const add = plan.find((pl) => !present.has(key(pl.name, pl.pos)));
      if (add && await toggleQueue(add, true)) {
        state.queue.push(add);
        state.ours.add(key(add.name, add.pos));
        saveOurs();
      }
    }
    if (swapped) {
      const why = wrong.filter((pl) => !keep.has(key(pl.name, pl.pos))).length;
      say(`reconciled: swapped ${swapped} (${why} outranked, ${swapped - why} out of order),` +
          ` kept ${good}`);
    }
    await clearFilters();
    return swapped;
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
    const plan = planQueue(CFG.QUEUE_SIZE, []).filter((p) => !present.has(key(p.name, p.pos))).slice(0, need);
    if (!plan.length) return;
    say(`queue ${queueCount()}/${CFG.QUEUE_SIZE} — adding ${plan.length}`);
    for (const p of plan) {
      if (myTurn()) { say('your turn started — stopping refill'); return; }
      if (await toggleQueue(p, true)) {
        state.queue.push(p);
        state.ours.add(key(p.name, p.pos));
        saveOurs();
        say(`queued ${p.name} ${p.pos}-${p.team} val ${p.val} (${p.role}, po ${p.playoffMod}, bye ${p.byeMod})`);
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
        if (!state.baselinePending && state.teamsConfirmed) computeBaseline();
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
        if (state.teamsConfirmed) computeBaseline();   // the one and only computation
      }

      observeShape();                        // narrow league size from the header
      foldPicks();                           // cheap header read, every tick

      // Your clock, your pick — the tick does nothing during your turn. The
      // last-second safety net runs on its own timer, because this one can be
      // busy inside a refill for ten seconds or more.
      if (myTurn()) return;

      const rc = roster().length;
      const weDrafted = rc > state.lastRoster;
      const short = queueCount() < CFG.QUEUE_SIZE;


      // Re-read the queue from the page every cycle. The human may have
      // reordered it, deleted from it, or added to it since the last pass, and a
      // reload wipes anything we remembered — so nothing is carried forward.
      await syncQueue();

      // Refresh the picks feed before RE-PROJECTING as well as before rebuilding.
      // The projection is only as good as the opponent rosters behind it, and those
      // come from this feed. A projection once ran with teamRosters empty: every
      // simulated team looked like it still needed a kicker and a defense, so the
      // model spent 29 picks on 11 kickers and 11 defenses and removed no receivers
      // at all, leaving the WR floor far too high.
      const needProjection = !state.proj || state.proj.round !== roundNow();
      if (weDrafted || short || needProjection) await syncPicksFromPanel();

      // Refresh the round's projection before anything reads it. Once per round is
      // enough — what survives to our subsequent pick does not meaningfully change
      // between two picks of the same round — and it runs here, once, rather than
      // inside the ranking that planQueue calls for every queue slot.
      await ensureProjection(draftPosition().overall);

      // Keep the queue honest against the CURRENT board, not just after our own
      // picks. Entries were only ever added, and pruneQueue drops the illegal —
      // never the merely outdated — so a defense queued in round 1 at +3.5 sat
      // there into round 2 while a receiver worth +25.6 went unqueued. Every pick
      // by anyone changes what is available, so the plan is reconciled each cycle.
      // The rebuild is a diff: whatever still earns its place stays put.
      if (weDrafted) state.lastRoster = rc;

      // Two different jobs, on two different clocks.
      //
      // MEMBERSHIP — dropping entries the ranking no longer justifies — is checked
      // every cycle. It costs nothing when the queue is right, and gating it by
      // round left plainly wrong entries stuck: a defense worth +3.5 and a kicker
      // worth +2.1 sat in the queue with backs and receivers worth 19 to 50
      // unqueued, and nothing could remove them until the next round.
      //
      // ORDER is rewritten only when a new round of floors lands, or right after
      // our own pick. Yahoo has no reorder primitive, so resequencing means
      // removing and re-adding; doing that against a board that shifts with every
      // pick is pure thrash, and the floors are what actually move the ranking.
      const projRound = state.proj ? state.proj.round : null;
      const mayReorder = weDrafted || projRound !== state.lastReconciledRound;
      if (mayReorder) state.lastReconciledRound = projRound;
      await reconcileQueue(mayReorder);

      // Flag the overlay while we click around the queue UI, so the human knows to
      // keep hands off rather than fighting us for the mouse.
      state.working = true;
      renderOverlay();
      try {
        await withPlayersTab(async () => {
          await pruneQueue();
          await replenish();
          if (queueCount() < CFG.QUEUE_SIZE) { await refill(); await clearFilters(); }
        });
      } finally { state.working = false; renderOverlay(); }

      try { localStorage.setItem('ys_dump', JSON.stringify(window.__queueDump())); } catch (e) {}
      renderOverlay();
    } catch (e) {
      say(`ERROR ${e.message}`);
    } finally {
      busy = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Overlay (optional, read-only)
  // ---------------------------------------------------------------------------

  let overlayEl = null;

  /**
   * Position the panel just LEFT of the roster column so it never covers your
   * team, overlapping the bottom-right of the player table instead. The roster
   * panel's left edge is measured at render time rather than hard-coded, so it
   * adapts to window width; CFG.OVERLAY_RIGHT_OFFSET is only the fallback.
   */
  function overlayOffsets() {
    const panel = myPanel();
    let right = CFG.OVERLAY_RIGHT_OFFSET;
    if (panel) {
      const r = panel.getBoundingClientRect();
      if (r.width > 0 && r.left > 200) {
        right = Math.round(window.innerWidth - r.left) + 12;
      }
    }
    return { right: Math.max(12, right) };
  }

  function overlay() {
    if (!CFG.SHOW_OVERLAY) return null;
    const { right } = overlayOffsets();
    if (overlayEl && overlayEl.isConnected) {
      overlayEl.style.right = `${right}px`;      // window may have been resized
      return overlayEl;
    }
    const vertical = /^top/.test(CFG.OVERLAY_CORNER) ? 'top:12px' : 'bottom:12px';
    overlayEl = document.createElement('div');
    // pointer-events:none is the safety property — clicks pass straight through to
    // Yahoo underneath, so the overlay can never cause a stray draft.
    overlayEl.style.cssText = `position:fixed;${vertical};right:${right}px;` +
      'z-index:2147483647;width:310px;max-height:60vh;overflow:hidden;pointer-events:none;' +
      'font:11.5px/1.45 ui-monospace,Menlo,monospace;background:rgba(17,19,24,.94);' +
      'color:#e8ecf0;border:1px solid #2b333c;border-radius:8px;padding:9px 11px;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.35)';
    document.body.appendChild(overlayEl);       // sibling of Yahoo's tree, never inside it
    return overlayEl;
  }

  /**
   * Shows what is ACTUALLY in the queue, and explains the number next to each
   * player. Deliberately does NOT repeat whose pick it is or the round — Yahoo
   * already shows both, and a second copy just goes stale.
   */
  function renderOverlay() {
    const el = overlay();
    if (!el) { if (overlayEl) { overlayEl.remove(); overlayEl = null; } return; }
    // Yahoo's autopick dialog carries no role=dialog, so match it by text.
    const dlg = [...document.querySelectorAll('div,section')]
      .some((e) => /autopick mode|inactivity/i.test(e.innerText || '') && (e.innerText || '').length < 400);
    if (dlg) { el.style.display = 'none'; return; }
    el.style.display = '';

    const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const badge = queueCount();
    // state.queue is itself a live read, refreshed every tick; prefer an even
    // fresher one when the Queue tab happens to be open right now.
    const live = liveQueue();
    const model = queueView();
    const source = live ? 'live' : 'synced';
    const q = live
      ? live.map((p) => Object.assign({}, p,
          model.find((m) => m.name === p.name && m.pos === p.pos) || {}))
      : model;
    const next = state.armed ? planQueue(3) : [];

    const row = (p, label, dim, yours) => {
      const bits = [];
      if (p.val === null) bits.push('no longer available');
      else {
        const repl = p.proj - (Number.isFinite(p.raw) ? p.raw : 0);
        bits.push(`scores ${Math.round(p.proj)}`);
        bits.push(`${Math.round(repl)} if you wait`);
        if (p.playoffMod && Math.abs(p.playoffMod - 1) > 0.0005) {
          bits.push(`playoff ×${p.playoffMod.toFixed(3)}`);
        }
        if (p.role === 'starter') bits.push(`fills ${p.pos} slot`);
        else if (p.role === 'flex') bits.push('fills flex');
        else if (p.role === 'reserve') bits.push('bench only');
        else if (p.role === 'must-fill') bits.push(`must fill ${p.pos}`);

        if (p.byeMod && p.byeMod < 1) bits.push(`bye clash −${((1 - p.byeMod) * 100).toFixed(0)}%`);
        if (p.teamMod && p.teamMod < 1) bits.push(`teammate −${((1 - p.teamMod) * 100).toFixed(0)}%`);
        // Ranked-up for depth, but the GAIN shown stays the honest figure.
        if (p.depthMult && p.depthMult > 1) {
          bits.push(`bench depth +${Math.round((p.depthMult - 1) * 100)}% (rank only)`);
        }
        if (p.gated) bits.push('held until the last rounds');
      }
      return `<div style="display:flex;gap:6px;margin-top:4px;opacity:${dim ? 0.6 : 1}">` +
        `<span style="color:#7c8894;width:11px">${label}</span>` +
        `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">` +
        `${esc(p.name)} <span style="color:#7c8894">${esc(p.pos)}${p.team ? '-' + esc(p.team) : ''}</span>` +
        `${yours ? ' <span style="color:#e0a340" title="you added this; never removed">◆</span>' : ''}</span>` +
        `<span style="color:${p.val > 0 ? '#5cb585' : '#7c8894'};text-align:right;width:44px">` +
        `${!Number.isFinite(p.val) ? (p.val === Infinity ? 'MUST' : '—')
           : (p.val > 0 ? '+' : '') + p.val.toFixed(1)}</span>` +
        // Playoff schedule shown separately, never folded into the value above.
        `<span style="text-align:right;width:38px;color:${!p.playoffDelta ? '#7c8894'
          : p.playoffDelta > 0 ? '#5cb585' : '#e27a72'}">` +
        `${!Number.isFinite(p.playoffDelta) || !p.playoffDelta || !Number.isFinite(p.val) ? ''
          : (p.playoffDelta > 0 ? '+' : '−') + Math.abs(p.playoffDelta).toFixed(1)}</span></div>` +
        `<div style="color:#7c8894;margin-left:17px;opacity:${dim ? 0.6 : 1}">${bits.join(' · ')}</div>`;
    };

    const busy = state.working
      ? `<div style="background:#e0a340;color:#12151a;font-weight:700;text-align:center;` +
        `margin:-9px -11px 7px;padding:5px 0;border-radius:7px 7px 0 0">` +
        `UPDATING QUEUE — HANDS OFF</div>` : '';

    el.innerHTML = busy +
      `<div style="display:flex;justify-content:space-between;border-bottom:1px solid #2b333c;padding-bottom:5px">` +
      `<b>QUEUE</b><span style="color:#7c8894">${q.length}/${CFG.QUEUE_SIZE}` +
      `${source === 'synced' ? ' <span style="color:#7c8894">(synced)</span>' : ''}` +
      `${badge !== q.length ? ` <span style="color:#e27a72">badge ${badge}</span>` : ''}</span></div>` +
      `<div style="display:flex;color:#7c8894;margin-top:4px;font-size:10px;letter-spacing:.06em">` +
      `<span style="flex:1">PLAYER</span><span style="width:44px;text-align:right">GAIN</span>` +
      `<span style="width:38px;text-align:right">SCHED</span></div>` +
      (q.length ? q.map((p, i) => row(p, i + 1, false, isHuman(p))).join('')
                : '<div style="color:#7c8894;margin-top:4px">empty</div>') +
      (next.length ? `<div style="color:#7c8894;border-top:1px dashed #2b333c;margin-top:7px;padding-top:4px">NEXT UP</div>` +
        next.map((p) => row(p, '·', true, false)).join('') : '') +
      `<div style="color:#7c8894;border-top:1px solid #2b333c;margin-top:7px;padding-top:5px">` +
      `<b style="color:#e0a340">◆</b> = you queued this; never removed automatically.<br>` +
      `<b style="color:#5cb585">SCHED</b> = points the fantasy-playoff schedule adds or ` +
      `removes. Kept out of GAIN so the headline stays comparable, but it does count ` +
      `toward queue order.<br>` +
      `<b style="color:#a7b2bd">GAIN</b> = season points you gain by taking this player ` +
      `now instead of the best one at his position still likely to be there at your ` +
      `next pick. Adjusted down if he can only sit on your bench, and for playoff ` +
      `schedule and bye-week clashes.` +
      `<div style="margin-top:3px">pool ${state.pool.size} · drafted ${state.taken.size} · ` +
      `<span style="color:${autodraftOn() ? '#e27a72' : '#5cb585'}">autodraft ${autodraftOn() ? 'ON' : 'off'}</span></div></div>`;
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
  let watchTrace = null;
  const autopickTimer = setInterval(() => {
    try {
      if (!CFG.AUTOPICK_AT_SECONDS || complete()) return;
      if (!myTurn()) { autopickTried = false; watchTrace = null; return; }
      if (autopickTried) return;
      const left = secondsLeft();
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
    try { renderOverlay(); annotateQueue(); }
    catch (e) {
      // Never swallow silently: a throw here previously left the overlay blank
      // with no explanation anywhere.
      if (paintErr !== e.message) { paintErr = e.message; say(`paint error: ${e.message}`); }
    }
  }, 1000);
  window.__queueStop = () => { clearInterval(timer); clearInterval(overlayTimer); clearInterval(autopickTimer);
    dialogObserver.disconnect(); if (overlayEl) overlayEl.remove();
    document.querySelectorAll('.ys-assist').forEach((e) => e.remove());   // leave the queue clean
    say('stopped'); };
  window.__queueState = state;
  window.__queueCfg = CFG;          // for diagnostics
  say(`armed — ${CFG.DRY_RUN ? 'DRY RUN' : 'LIVE'}, target ${CFG.QUEUE_SIZE}, slot ${CFG.SLOT}`);
})();
