// ==UserScript==
// @name         Yahoo Fantasy Draft Autopilot
// @namespace    jfree.fantasy
// @version      3.0
// @description  Drafts autonomously in a Yahoo draft room by optimizing on the room's own projected points.
// @match        https://football.fantasysports.yahoo.com/draftclient/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
//
// v2 rewrite. v1 carried an external ranked board and matched abbreviated names
// ("C. Lamb") against it. That was the root of every bad pick: surname matching
// took Wan'Dale Robinson for Bijan Robinson and Jordan Love (QB) for Jeremiyah
// Love (RB), and even initial+surname+position+team still collided (Brian vs
// Bijan Robinson, both RB-Atl).
//
// v2 needs no names at all. The draft room's own table publishes "Proj Pts" for
// every available player under THIS league's scoring. The script reads that
// number, values each player against what it expects to still be available at
// its next turn, and clicks the button in the row it just evaluated. There is
// nothing to mismatch.
//
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // CONFIGURE THESE TWO FIRST, then run a full mock with DRY_RUN true.
  //   SLOT  — the position you were ACTUALLY assigned. Joining is racy: a
  //           requested slot 3 came back as 9 and as 12 on two of four attempts,
  //           announced only by one line on the waiting-room page. Check it.
  //   TEAMS — league size. SLOT and TEAMS set the snake gap, which drives the
  //           entire valuation; wrong values quietly produce wrong picks.
  // ---------------------------------------------------------------------------
  const CFG = {
    DRY_RUN: true,          // log decisions without clicking. Do a full mock this way first.
    SLOT: 1,                // <-- your actual draft position
    TEAMS: 12,              // <-- league size
    ROUNDS: 14,             // fallback only — real size is read from "YOUR TEAM (n/m)"
    REQUIRED: { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 },
    STARTERS: { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 },
    FLEX: 1,                // W/R/T
    // QB capped at 1: a backup QB can never start, so he is worth almost nothing.
    CAPS:     { QB: 1, RB: 6, WR: 7, TE: 2, K: 1, DEF: 1 },
    LATE_ONLY: ['K', 'DEF'], // only in the final two rounds
    KEEP_QUEUED: 5,                  // how deep to keep Yahoo's queue stocked
  };

  const LOG = [];
  const say = (m) => { LOG.push(m); console.log('[autopilot]', m); };
  window.__autopilotLog = LOG;

  // --- Column discovery -----------------------------------------------------
  // Header row is: Queue | Player | XRank | ADP | Bye | Proj Pts | GP | ...
  // Resolve by header text rather than fixed index, so a layout change is loud.
  let COL = null;
  function columns(tbl) {
    if (COL) return COL;
    const hs = [...tbl.querySelectorAll('thead th')].map((h) => h.innerText.replace(/\s+/g, ' ').trim());
    const idx = (re) => hs.findIndex((h) => re.test(h));
    COL = { player: idx(/^Player$/i), adp: idx(/^ADP$/i), proj: idx(/Proj\s*Pts/i) };
    if (COL.player < 0 || COL.proj < 0) { say('FATAL: could not find Player/Proj Pts columns'); COL = null; }
    return COL;
  }

  // --- Reading the room -----------------------------------------------------
  function available() {
    const tbl = [...document.querySelectorAll('table')].find((t) => t.querySelector('button'));
    if (!tbl) return [];
    const c = columns(tbl);
    if (!c) return [];
    return [...tbl.querySelectorAll('tbody tr')].filter((r) => r.querySelector('button')).map((r) => {
      const cells = r.children;
      if (cells.length <= c.proj) return null;
      const who = cells[c.player].innerText.replace(/\s+/g, ' ').trim();
      const m = who.match(/\b(QB|RB|WR|TE|K|DEF)\b\s+([A-Za-z]{2,3})/);
      const proj = parseFloat(cells[c.proj].innerText);
      const adp = parseFloat(cells[c.adp]?.innerText);
      if (!m || !isFinite(proj)) return null;
      return { who: who.slice(0, 30), pos: m[1], team: m[2], proj,
               adp: isFinite(adp) ? adp : 999, row: r };
    }).filter(Boolean);
  }

  // Roster truth always comes from the page, never from what we think we clicked.
  // It MUST come from the panel headed "YOUR TEAM (n/m)" — other panels show the
  // team currently picking, which silently reads as your own roster.
  function myPanel() {
    return [...document.querySelectorAll('div,section,aside')]
      .filter((e) => /YOUR TEAM\s*\(/i.test(e.innerText || '') && (e.innerText || '').length < 600)
      .sort((a, b) => a.innerText.length - b.innerText.length)[0] || null;
  }
  function rosterSize() {                       // "(8/15)" -> 15. Mocks use 15, not 14.
    const p = myPanel(); if (!p) return CFG.ROUNDS;
    const m = p.innerText.match(/YOUR TEAM\s*\(\d+\/(\d+)\)/i);
    return m ? +m[1] : CFG.ROUNDS;
  }
  function roster() {
    const p = myPanel(); if (!p) return [];
    return [...p.querySelectorAll('.ys-player')].map((x) => {
      const t = x.innerText.replace(/\s+/g, ' ').trim();
      // Anchor on the token before team+Bye: a bare /\b(K)\b/ matches the INITIAL
      // in "K. Walker III" and files a running back as your kicker.
      // Defenses render as "Lions DEF Bye 6" — no initial, no team abbreviation.
      const m = t.match(/\b(QB|RB|WR|TE|K|DEF)\b\s+(?:[A-Za-z]{2,3}\s+)?Bye/);
      return m ? { who: t.slice(0, 28), pos: m[1] } : null;
    }).filter(Boolean);
  }

  const roundInfo = () => {
    const m = document.body.innerText.match(/Round\s*(\d+),\s*Pick\s*(\d+)/i);
    return m ? { rd: +m[1], pk: +m[2] } : { rd: 0, pk: 0 };
  };
  const complete = () => /Draft Complete/i.test(document.body.innerText);

  // "10 picks until your turn" ALSO contains "your turn", and "You are next" means
  // the pick BEFORE yours — firing on it clicks Draft while off the clock, a no-op
  // that costs you the pick to autodraft. Only these two forms mean you are up.
  const myTurn = () => {
    const t = document.body.innerText.replace(/\s+/g, ' ');
    return /YOUR TURN,\s*DRAFT NOW/i.test(document.title) || /YOUR TURN\s*[•·]/i.test(t);
  };

  // Snake gap from your slot to your next pick.
  const gapTo = (rd) => (rd % 2 === 1 ? 2 * (CFG.TEAMS - CFG.SLOT) + 1 : 2 * CFG.SLOT - 1);

  // --- Valuation ------------------------------------------------------------
  // A player is worth his projection MINUS the projection of the best player at
  // his position you can still expect at your next turn. That prices scarcity
  // automatically: it is why a 300-point QB can be worth less than a 190-point
  // RB when every other QB also projects near 300.
  function rank() {
    const A = available();
    if (!A.length) return null;
    const { rd } = roundInfo();
    const have = roster();
    const size = rosterSize();
    const count = (p) => have.filter((x) => x.pos === p).length;
    const missing = Object.entries(CFG.REQUIRED)
      .flatMap(([p, k]) => Array(Math.max(0, k - count(p))).fill(p));
    const picksLeft = size - have.length;

    // Players already on your roster must be excluded. Without this the script
    // re-picked a player it already owned; the click was a no-op and the pick was
    // lost to autodraft, which spent it on a second quarterback.
    const owned = new Set(have.map((r) => r.who.replace(/\s+Bye.*$/, '').trim()));
    const legal = (a) => {
      if (owned.has(a.who.replace(/\s+Bye.*$/, '').trim())) return false;
      if (count(a.pos) >= CFG.CAPS[a.pos]) return false;
      if (CFG.LATE_ONLY.includes(a.pos) && rd < size - 1) return false;
      return true;
    };

    // No slack left to defer a required slot. Without this the draft ends with an
    // unfillable lineup: permitting DEF late is not the same as requiring it.
    if (missing.length >= picksLeft && picksLeft > 0) {
      const pos = missing[0];
      const f = A.filter((a) => a.pos === pos).sort((x, y) => y.proj - x.proj)[0];
      if (f) return [{ ...f, val: Infinity, tier: 'must-fill',
                       why: `MUST-FILL ${pos} (${picksLeft} picks, ${missing.length} required)` }];
    }

    const gap = gapTo(rd);
    const gone = [...A].sort((a, b) => a.adp - b.adp).slice(0, gap);   // ADP predicts who leaves
    const taken = {};
    gone.forEach((a) => { taken[a.pos] = (taken[a.pos] || 0) + 1; });
    const nextBest = {};
    ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].forEach((p) => {
      const l = A.filter((a) => a.pos === p).sort((a, b) => b.proj - a.proj);
      const i = taken[p] || 0;
      nextBest[p] = l[i] ? l[i].proj : (l.length ? l[l.length - 1].proj : 0);
    });

    // Value must be measured against YOUR STARTING LINEUP, not generic replacement.
    // Scoring a 2nd QB off league-wide replacement valued Trevor Lawrence at +17.9
    // in a live mock while Hurts was already rostered — a player who can never start.
    const flexUsed = ['RB', 'WR', 'TE']
      .reduce((n, p) => n + Math.max(0, count(p) - CFG.STARTERS[p]), 0);

    return A.filter(legal).map((a) => {
      const raw = a.proj - nextBest[a.pos];
      let mult = 1, tier = 'starter';
      if (count(a.pos) >= CFG.STARTERS[a.pos]) {
        if (['RB', 'WR', 'TE'].includes(a.pos) && flexUsed < CFG.FLEX) { mult = 0.9; tier = 'flex'; }
        else { mult = 0.2; tier = 'bench'; }            // insurance only
      }
      return { ...a, raw: +raw.toFixed(1), val: +(raw * mult).toFixed(2), tier,
               why: `proj ${a.proj} − next-turn ${a.pos} ${nextBest[a.pos].toFixed(1)} = ${raw.toFixed(1)} ×${mult} (${tier}), gap ${gap}` };
    }).sort((x, y) => y.val - x.val);
  }

  // --- Acting ---------------------------------------------------------------
  // Two mechanisms, because polling alone loses races. In a real mock this tab
  // was document.hidden === true, browsers throttle background timers to >=1s,
  // and Yahoo's autodraft took roughly half the turns before the script woke up
  // — twice ending the draft with no defense.
  //
  // 1. Keep YAHOO'S OWN QUEUE stocked in our priority order. The room states
  //    "Autodraft picks will come from here first", so even a lost race spends
  //    the pick on our top choice instead of Yahoo's.
  // 2. Click Draft directly when we do win the race.
  function queueTop(list) {
    // The queue control is the star in each row's first cell. Verify this in a
    // DRY_RUN before trusting it — it is the least-confirmed selector here.
    let queued = 0;
    for (const cand of list.slice(0, CFG.KEEP_QUEUED)) {
      const star = cand.row.querySelector('[aria-label*="queue" i],[title*="queue" i],button[class*="star" i]');
      if (star && star.getAttribute('aria-pressed') !== 'true') {
        if (!CFG.DRY_RUN) star.click();
        queued++;
      }
    }
    if (queued) say(`queued ${queued}: ${list.slice(0, queued).map((x) => x.who).join(', ')}`);
  }

  const done = new Set();
  let lastQueue = 0;
  var obs, timer;
  function act(src) {
    if (complete()) return;
    // A full roster means we are done, whatever the header still says. Without
    // this the script kept firing after 15/15 and logged the same pick nine times.
    if (roster().length >= rosterSize()) { finish(); return; }
    // CHEAP GUARD FIRST. The observer fires on every DOM mutation and this room
    // mutates once a second as the clock ticks; ranking 100 rows on each of those
    // pegs the renderer (it froze a debugging session). Only do real work when the
    // clock is ours, plus an occasional queue top-up.
    const mine = myTurn();
    if (!mine && Date.now() - lastQueue < 5000) return;

    const list = rank();
    if (!list || !list.length) return;

    if (Date.now() - lastQueue >= 5000) { lastQueue = Date.now(); queueTop(list); }
    if (!mine) return;

    const { rd, pk } = roundInfo();
    const key = `${rd}-${pk}`;
    if (done.has(key)) return;
    const best = list[0];
    const line = `R${rd} ${best.who} [${best.pos}] val ${best.val} | ${best.why} | alts: ` +
                 list.slice(1, 4).map((x) => `${x.who} v${x.val}`).join(' · ') + ` <${src}>`;
    if (CFG.DRY_RUN) { say('DRY RUN ' + line); done.add(key); return; }
    const before = roster().length;
    best.row.querySelector('button').click();
    say(line);
    // Confirm it landed. A click on a stale row silently does nothing, and marking
    // the key done anyway forfeits the pick to autodraft.
    setTimeout(() => {
      if (roster().length > before) { done.add(key); }
      else { say(`pick did not land (${best.who}) — will retry`); }
    }, 1200);
  }

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    clearInterval(timer); obs.disconnect();
    say(`done — roster full (${roster().length}/${rosterSize()})`);
  }

  // MutationObserver fires on the same task as the DOM change, so it is not
  // subject to background-timer throttling the way setInterval is.
  var obs = new MutationObserver(() => act('obs'));
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  var timer = setInterval(() => act('poll'), 700);   // safety net

  window.__autopilotStop = () => { clearInterval(timer); obs.disconnect(); say('stopped'); };
  say(`armed — ${CFG.DRY_RUN ? 'DRY RUN' : 'LIVE'}, slot ${CFG.SLOT}, roster ${rosterSize()}; __autopilotStop() to halt`);
})();
