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
    QUEUE_SIZE: 5,

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
    // Read-only panel showing the live ranking and why. Off by default.
    SHOW_OVERLAY: false,

    // --- 5. last-second pick ------------------------------------------------
    // Seconds left on YOUR clock at which the manager drafts the top of the queue
    // itself. 0 = never; let the clock expire and Yahoo take the queue top.
    //
    // Setting this above 0 is not just convenience: Yahoo switches your team into
    // autopick mode whenever a timer actually expires, and every later pick is
    // then made for you. Picking at 2 seconds means the timer never expires, so
    // that never triggers.
    AUTOPICK_AT_SECONDS: 0,

    // --- 4. bye weeks -------------------------------------------------------
    // 0 ignores byes entirely. 1 means a player whose bye would leave a starting
    // slot empty is worth nothing. Scales with how badly the bye collides.
    BYE_FACTOR: 0.5,
  };

  const LOG = [];
  const say = (m) => { LOG.push(`${new Date().toISOString().slice(11, 19)} ${m}`); console.log('[queue]', m); };
  window.__queueLog = LOG;

  // ---------------------------------------------------------------------------
  // Reading the room
  // ---------------------------------------------------------------------------

  const playerTable = () => [...document.querySelectorAll('table')]
    .find((t) => t.querySelector('.ys-addqueue'));

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
  function secondsLeft() {
    const m = document.body.innerText.match(/\b(\d{1,2}):(\d{2})\b/);
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }

  /**
   * Draft the top of our queue with the clock nearly expired. Only ever called
   * during your own turn, and only inside the final AUTOPICK_AT_SECONDS.
   */
  async function draftQueueTop() {
    const id = state.queued[0];
    const pl = id && state.pool.get(id);
    if (!pl) { say('autopick threshold hit but queue is empty'); return false; }
    let row = document.querySelector(`.ys-player[data-id="${pl.id}"]`)?.closest('tr');
    if (!row) {
      setSearch(pl.name.replace(/^[A-Z]\.\s*/, ''));
      await sleep(800);
      row = document.querySelector(`.ys-player[data-id="${pl.id}"]`)?.closest('tr');
    }
    // The Draft button only exists in rows while it is your turn.
    const btn = row && [...row.querySelectorAll('button')]
      .find((b) => /^draft$/i.test((b.innerText || '').trim()));
    if (!btn) { say(`autopick: no Draft button for ${pl.name}`); return false; }
    btn.click();
    say(`autopick at ${secondsLeft()}s — drafted ${pl.name} (${pl.pos}) from queue top`);
    return true;
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
  function ensureLiveDrafting() {
    let acted = false;

    const d = document.querySelector('[role=dialog]');
    if (d && /autopick|autodraft|inactivity/i.test(d.innerText || '')) {
      const btn = [...d.querySelectorAll('button')].pop();
      if (btn) { btn.click(); say('dismissed autopick dialog'); acted = true; }
    }

    // The toggle is outline-styled when off and filled when on, with no aria state
    // to read, so detect it by whether the button has a solid background.
    const tog = [...document.querySelectorAll('button')]
      .find((b) => /^Autodraft$/i.test((b.innerText || '').trim()));
    if (tog) {
      const bg = getComputedStyle(tog).backgroundColor;
      const solid = bg && !/rgba?\(0, 0, 0, 0\)|transparent|rgb\(255, 255, 255\)/i.test(bg);
      if (solid) { tog.click(); say('autodraft was on — switched off'); acted = true; }
    }
    return acted;
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const state = {
    pool: new Map(),        // id -> player, read once
    taken: new Set(),       // normalized "NAME|POS" of everyone drafted
    queued: [],             // ids we put in the queue, our own model
    seenPicks: new Set(),   // pick numbers already folded into `taken`
    armed: false,
    lastRoster: 0,
  };

  const key = (name, pos) => `${name.replace(/\s+/g, ' ').trim().toUpperCase()}|${pos}`;

  function foldPicks() {
    let n = 0;
    for (const lp of scanLastPick()) {
      if (state.seenPicks.has(lp.pick)) continue;
      state.seenPicks.add(lp.pick);
      state.taken.add(key(lp.name, lp.pos));
      n++;
      state.queued = state.queued.filter((id) => {
        const pl = state.pool.get(id);
        return !pl || key(pl.name, pl.pos) !== key(lp.name, lp.pos);
      });
    }
    for (const p of scanPicks()) {
      if (state.seenPicks.has(p.pick)) continue;
      state.seenPicks.add(p.pick);
      n++;
      const m = p.text.match(/^(.+?)\s+\b(QB|RB|WR|TE|K|DEF)\b/);
      if (m) {
        state.taken.add(key(m[1], m[2]));
        // Anyone drafted is out of our queue, whoever took them.
        state.queued = state.queued.filter((id) => {
          const pl = state.pool.get(id);
          return !pl || key(pl.name, pl.pos) !== key(m[1], m[2]);
        });
      }
    }
    return n;
  }

  // ---------------------------------------------------------------------------
  // Valuation — same model as the autodraft script
  // ---------------------------------------------------------------------------

  const gapTo = (rd) => (rd % 2 === 1 ? 2 * (CFG.TEAMS - CFG.SLOT) + 1 : 2 * CFG.SLOT - 1);
  const roundNow = () => {
    const m = document.body.innerText.match(/Round\s*(\d+),\s*Pick\s*(\d+)/i);
    return m ? +m[1] : 1;
  };

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

    const avail = [...state.pool.values()]
      .filter((p) => !state.taken.has(key(p.name, p.pos)))
      .filter((p) => !mine.has(key(p.name, p.pos)))
      .filter((p) => !state.queued.includes(p.id) && !planned.has(p.id));

    // A required position we can no longer defer overrides everything.
    const missing = Object.entries(CFG.STARTERS)
      .flatMap(([p, k]) => Array(Math.max(0, k - count(p))).fill(p));
    const picksLeft = size - have.length;
    if (missing.length >= picksLeft && picksLeft > 0) {
      return avail.filter((p) => p.pos === missing[0])
        .sort((a, b) => b.proj - a.proj)
        .map((p) => ({ ...p, val: Infinity, why: `must-fill ${missing[0]}` }));
    }

    const byPos = {};
    for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
      byPos[pos] = avail.filter((p) => p.pos === pos).sort((a, b) => b.proj - a.proj);
    }

    // Attrition before your next turn, predicted by ADP over the snake gap.
    const gap = gapTo(rd);
    const gone = [...avail].sort((a, b) => a.adp - b.adp).slice(0, gap);
    const attrition = {};
    gone.forEach((p) => { attrition[p.pos] = (attrition[p.pos] || 0) + 1; });

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
    const replacement = (pos) => {
      const l = byPos[pos];
      if (!l.length) return 0;
      const i = (pos === 'K' || pos === 'DEF')
        ? Math.min(l.length - 1, CFG.TEAMS - 1)
        : (attrition[pos] || 0);
      return (l[i] || l[l.length - 1]).proj;
    };

    const flexUsed = ['RB', 'WR', 'TE']
      .reduce((n, p) => n + Math.max(0, count(p) - CFG.STARTERS[p]), 0);

    return avail.filter((p) => count(p.pos) < CFG.CAPS[p.pos]).map((p) => {
      const raw = p.proj - replacement(p.pos);

      let weight = CFG.WEIGHT_STARTER, role = 'starter';
      if (count(p.pos) >= CFG.STARTERS[p.pos]) {
        if (['RB', 'WR', 'TE'].includes(p.pos) && flexUsed < CFG.FLEX) {
          weight = CFG.WEIGHT_FLEX; role = 'flex';
        } else {
          weight = CFG.WEIGHT_RESERVE; role = 'reserve';
        }
      }

      const pm = playoffModifier(p.team);
      const bm = byeMultiplier(p, have);
      const val = raw * weight * pm * bm;

      return { ...p, raw: +raw.toFixed(2), val: +val.toFixed(2), role,
               playoffMod: +pm.toFixed(4), byeMod: +bm.toFixed(3),
               why: `${p.proj} - repl ${(p.proj - raw).toFixed(1)} = ${raw.toFixed(1)}` +
                    ` x${weight}(${role}) x${pm.toFixed(3)}(po) x${bm.toFixed(2)}(bye)` };
    }).sort((a, b) => b.val - a.val);
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
  function planQueue(n) {
    const b2b = backToBack();
    const chosen = [];
    const sequence = [];                 // provisional roster additions
    while (chosen.length < n) {
      const ranked = rankAvailable(sequence).filter((p) => !chosen.some((c) => c.id === p.id));
      if (!ranked.length) break;
      const pick = ranked[0];
      chosen.push(pick);
      sequence.push(pick);

      if (chosen.length === 1 && !b2b && isScarce(pick.pos, roster())) {
        const backup = rankAvailable([])
          .find((p) => p.pos === pick.pos && p.id !== pick.id);
        if (backup && chosen.length < n) {
          chosen.push(backup);           // insurance only — NOT part of the sequence
          say(`queue: ${backup.name} added as ${pick.pos} backup behind ${pick.name}`);
        }
      }
    }

    if (b2b) {
      // Hard guard, independent of how the sequence was built.
      const seen = { K: 0, DEF: 0 };
      const capped = chosen.filter((p) => {
        if (p.pos !== 'K' && p.pos !== 'DEF') return true;
        return ++seen[p.pos] <= 1;
      });
      if (capped.length !== chosen.length) {
        say(`back-to-back picks — capped queue at one K and one DEF`);
      }
      return capped;
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
    } else say(`row not found: ${player.name}`);
    if (usedSearch) { setSearch(prev); await sleep(500); }
    return ok;
  }

  /**
   * Remove everything we queued. Called after WE draft: the roster changed, so
   * every queued player was chosen against a stale set of needs.
   */
  async function purgeQueue() {
    let removed = 0;
    for (const id of state.queued.slice()) {
      const pl = state.pool.get(id);
      if (!pl) { state.queued = state.queued.filter((x) => x !== id); continue; }
      if (await toggleQueue(pl, false)) {
        state.queued = state.queued.filter((x) => x !== id);
        removed++;
      }
    }
    if (removed) say(`purged ${removed} from queue after our pick`);
    return removed;
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
    const low = Object.entries(availableByPos()).filter(([, n]) => n < 50).map(([pos]) => pos);
    if (!low.length) return 0;
    const prev = sel.value;
    let added = 0;
    for (const pos of low) {
      const opt = [...sel.options].find((o) => o.text.trim() === POS_LABEL[pos]);
      if (!opt) continue;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(1500);
      for (const p of readRows()) if (!state.pool.has(p.id)) { state.pool.set(p.id, p); added++; }
      say(`replenished ${pos}: ${availableByPos()[pos] || 0} now available`);
    }
    sel.value = prev;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(800);
    return added;
  }

  async function refill() {
    const need = CFG.QUEUE_SIZE - queueCount();
    if (need <= 0) return;
    const plan = planQueue(need);
    if (!plan.length) return;
    say(`queue ${queueCount()}/${CFG.QUEUE_SIZE} — adding ${plan.length}`);
    for (const p of plan) {
      if (myTurn()) { say('your turn started — stopping refill'); return; }
      if (await toggleQueue(p, true)) {
        state.queued.push(p.id);
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

  async function readPool() {
    const sel = posFilter();
    const prev = sel?.value;
    for (const label of CFG.POOL) {
      if (sel) {
        const opt = [...sel.options].find((o) => o.text.trim() === label);
        if (!opt) { say(`pool: no filter option "${label}"`); continue; }
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(1500);
      }
      let added = 0;
      for (const p of readRows()) if (!state.pool.has(p.id)) { state.pool.set(p.id, p); added++; }
      say(`pool: ${label} +${added}`);
    }
    if (sel && prev !== undefined) {
      sel.value = prev;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(800);
    }
    const byPos = [...state.pool.values()].reduce((a, p) => (a[p.pos] = (a[p.pos] || 0) + 1, a), {});
    say(`pool read complete: ${state.pool.size} — ${JSON.stringify(byPos)}`);
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
      queuedIds: state.queued,
      top25: ranked.slice(0, 25).map((p) => ({
        name: p.name, pos: p.pos, team: p.team, bye: p.bye, proj: p.proj, adp: p.adp,
        raw: p.raw, val: p.val, role: p.role, playoffMod: p.playoffMod, byeMod: p.byeMod,
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

      if (!state.armed) {
        if (!playerTable()) return;          // room not up yet
        await readPool();
        state.lastRoster = roster().length;
        state.armed = true;
      }

      foldPicks();                           // cheap header read, every tick

      if (myTurn()) {
        // Your clock, your pick. The only exception is the last-second safety net.
        const left = secondsLeft();
        if (CFG.AUTOPICK_AT_SECONDS > 0 && left !== null && left <= CFG.AUTOPICK_AT_SECONDS) {
          await draftQueueTop();
        }
        return;
      }

      const rc = roster().length;
      const weDrafted = rc > state.lastRoster;
      const short = queueCount() < CFG.QUEUE_SIZE;

      // Only disturb the tabs when we are actually about to rebuild the queue.
      if (weDrafted || short) await syncPicksFromPanel();

      // Our own pick invalidates the queue's premise: the roster changed, so
      // every queued player was chosen against needs that no longer hold.
      if (weDrafted) { state.lastRoster = rc; await purgeQueue(); }

      await replenish();
      if (queueCount() < CFG.QUEUE_SIZE) await refill();

      try { localStorage.setItem('ys_dump', JSON.stringify(window.__queueDump())); } catch (e) {}
    } catch (e) {
      say(`ERROR ${e.message}`);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, CFG.TICK_MS);
  window.__queueStop = () => { clearInterval(timer); dialogObserver.disconnect(); say('stopped'); };
  window.__queueState = state;
  say(`armed — ${CFG.DRY_RUN ? 'DRY RUN' : 'LIVE'}, target ${CFG.QUEUE_SIZE}, slot ${CFG.SLOT}`);
})();
