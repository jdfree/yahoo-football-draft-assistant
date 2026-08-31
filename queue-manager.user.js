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
    QUEUE_TARGET: 5,
    TICK_MS: 2000,
    TEAMS: 12,
    SLOT: 1,              // <-- your ACTUAL slot; the waiting room can reassign it
    STARTERS: { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 },
    FLEX: 1,
    CAPS: { QB: 2, RB: 6, WR: 7, TE: 3, K: 1, DEF: 1 },
    LATE_ONLY: ['K', 'DEF'],   // keep these out of the queue until the end
    POOL: [['QB', 75], ['TE', 75], ['W/R/T', 300], ['K', 999], ['DEF', 999]],
  };

  const LOG = [];
  const say = (m) => { LOG.push(`${new Date().toISOString().slice(11, 19)} ${m}`); console.log('[queue]', m); };
  window.__queueLog = LOG;

  // ---------------------------------------------------------------------------
  // Reading the room
  // ---------------------------------------------------------------------------

  const playerTable = () => [...document.querySelectorAll('table')]
    .find((t) => t.querySelector('.ys-addqueue'));

  /** Column indexes by header text — never by position, the layout shifts. */
  let COL = null;
  function columns(tbl) {
    if (COL) return COL;
    const hs = [...tbl.querySelectorAll('thead th')].map((h) => h.innerText.replace(/\s+/g, ' ').trim());
    const ix = (re) => hs.findIndex((h) => re.test(h));
    COL = { player: ix(/^Player$/i), adp: ix(/^ADP$/i), proj: ix(/Proj\s*Pts/i), bye: ix(/^Bye$/i) };
    if (COL.player < 0 || COL.proj < 0) { say('FATAL: Player/Proj Pts columns not found'); COL = null; }
    return COL;
  }

  /**
   * Each row carries `.ys-addqueue[data-id]` — Yahoo's own player id. This is the
   * only stable key in the room. Names are abbreviated to a first initial and
   * collide badly (B. Robinson is two different running backs), so never key on them.
   */
  function readRows() {
    const tbl = playerTable();
    if (!tbl) return [];
    const c = columns(tbl);
    if (!c) return [];
    return [...tbl.querySelectorAll('tbody tr')].map((r) => {
      const q = r.querySelector('.ys-addqueue');
      if (!q) return null;
      const cells = r.children;
      const who = cells[c.player]?.innerText.replace(/\s+/g, ' ').trim() || '';
      const m = who.match(/\b(QB|RB|WR|TE|K|DEF)\b/);
      const proj = parseFloat(cells[c.proj]?.innerText);
      const adp = parseFloat(cells[c.adp]?.innerText);
      if (!m || !Number.isFinite(proj)) return null;
      return {
        id: q.getAttribute('data-id'),
        name: who.split('\n')[0].trim(),
        pos: m[1],
        team: (who.match(/\b(QB|RB|WR|TE|K|DEF)\b\s*[·|]?\s*([A-Za-z]{2,3})/) || [])[2] || '',
        proj,
        adp: Number.isFinite(adp) ? adp : 999,
        bye: parseInt(cells[c.bye]?.innerText, 10) || null,
        row: r,
      };
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
      const m = t.match(/\b(QB|RB|WR|TE|K|DEF)\b\s+(?:[A-Za-z]{2,3}\s+)?Bye/);
      return m ? { name: t.split(/\s{2,}|\n/)[0], pos: m[1] } : null;
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

  const myTurn = () => {
    const t = document.body.innerText.replace(/\s+/g, ' ');
    return /YOUR TURN,\s*DRAFT NOW/i.test(document.title) || /YOUR TURN\s*[•·]/i.test(t);
  };
  const complete = () => /Draft Complete/i.test(document.body.innerText);

  /**
   * Yahoo forces you into autopick mode after a stretch of inactivity and puts up
   * a dialog saying so. Left alone it takes the pick out of your hands entirely,
   * which is the opposite of the point here. Dismiss it whenever it appears.
   */
  function dismissInactivityDialog() {
    const d = document.querySelector('[role=dialog]');
    if (!d || !/autopick|inactivity/i.test(d.innerText || '')) return false;
    const btn = [...d.querySelectorAll('button')].pop();
    if (btn) { btn.click(); say('dismissed autopick-inactivity dialog'); return true; }
    return false;
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
  };

  const key = (name, pos) => `${name.replace(/\s+/g, ' ').trim().toUpperCase()}|${pos}`;

  function foldPicks() {
    for (const p of scanPicks()) {
      if (state.seenPicks.has(p.pick)) continue;
      state.seenPicks.add(p.pick);
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
  }

  // ---------------------------------------------------------------------------
  // Valuation — same model as the autodraft script
  // ---------------------------------------------------------------------------

  const gapTo = (rd) => (rd % 2 === 1 ? 2 * (CFG.TEAMS - CFG.SLOT) + 1 : 2 * CFG.SLOT - 1);
  const roundNow = () => {
    const m = document.body.innerText.match(/Round\s*(\d+),\s*Pick\s*(\d+)/i);
    return m ? +m[1] : 1;
  };

  function rankAvailable() {
    const have = roster();
    const size = rosterSize();
    const rd = roundNow();
    const count = (p) => have.filter((x) => x.pos === p).length;
    const mine = new Set(have.map((h) => key(h.name, h.pos)));

    const avail = [...state.pool.values()]
      .filter((p) => !state.taken.has(key(p.name, p.pos)))
      .filter((p) => !mine.has(key(p.name, p.pos)))
      .filter((p) => !state.queued.includes(p.id));

    // Required positions we can no longer defer.
    const missing = Object.entries(CFG.STARTERS)
      .flatMap(([p, k]) => Array(Math.max(0, k - count(p))).fill(p));
    const picksLeft = size - have.length;
    const forced = missing.length >= picksLeft && picksLeft > 0 ? missing[0] : null;
    if (forced) {
      return avail.filter((p) => p.pos === forced).sort((a, b) => b.proj - a.proj);
    }

    const legal = (p) => {
      if (count(p.pos) >= CFG.CAPS[p.pos]) return false;
      if (CFG.LATE_ONLY.includes(p.pos) && rd < size - 1) return false;
      return true;
    };

    const gap = gapTo(rd);
    const gone = [...avail].sort((a, b) => a.adp - b.adp).slice(0, gap);
    const attrition = {};
    gone.forEach((p) => { attrition[p.pos] = (attrition[p.pos] || 0) + 1; });
    const nextBest = {};
    for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
      const l = avail.filter((p) => p.pos === pos).sort((a, b) => b.proj - a.proj);
      const i = attrition[pos] || 0;
      nextBest[pos] = l[i] ? l[i].proj : (l.length ? l[l.length - 1].proj : 0);
    }
    const flexUsed = ['RB', 'WR', 'TE']
      .reduce((n, p) => n + Math.max(0, count(p) - CFG.STARTERS[p]), 0);

    return avail.filter(legal).map((p) => {
      const raw = p.proj - nextBest[p.pos];
      let mult = 1;
      if (count(p.pos) >= CFG.STARTERS[p.pos]) {
        mult = (['RB', 'WR', 'TE'].includes(p.pos) && flexUsed < CFG.FLEX) ? 0.9 : 0.2;
      }
      return { ...p, val: +(raw * mult).toFixed(2) };
    }).sort((a, b) => b.val - a.val);
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
  async function enqueue(player) {
    let el = document.querySelector(`.ys-addqueue[data-id="${player.id}"]`);
    let usedSearch = false;
    const prev = searchBox()?.value ?? '';

    if (!el) {
      if (!setSearch(player.name.replace(/^[A-Z]\.\s*/, ''))) return false;
      usedSearch = true;
      await sleep(900);
      el = document.querySelector(`.ys-addqueue[data-id="${player.id}"]`);
    }

    let ok = false;
    if (el) {
      const before = queueCount();
      if (CFG.DRY_RUN) {
        say(`DRY RUN would queue ${player.name} (${player.pos}) val ${player.val ?? '-'}`);
        ok = true;
      } else {
        el.click();
        await sleep(700);
        ok = queueCount() > before;   // trust the badge, not the click
        say(ok ? `queued ${player.name} (${player.pos}) val ${player.val ?? '-'}`
               : `queue click did not take for ${player.name}`);
      }
    } else {
      say(`could not locate row for ${player.name}`);
    }

    if (usedSearch) { setSearch(prev); await sleep(500); }
    return ok;
  }

  async function refill() {
    const need = CFG.QUEUE_TARGET - queueCount();
    if (need <= 0) return;
    const ranked = rankAvailable();
    if (!ranked.length) return;
    say(`queue at ${queueCount()}/${CFG.QUEUE_TARGET}, adding ${need}`);
    for (const p of ranked.slice(0, need)) {
      if (myTurn()) { say('your turn started — stopping mid-refill'); return; }
      const ok = await enqueue(p);
      if (ok && !CFG.DRY_RUN) state.queued.push(p.id);
      else if (ok && CFG.DRY_RUN) state.queued.push(p.id);
    }
  }

  // ---------------------------------------------------------------------------
  // One-time pool read
  // ---------------------------------------------------------------------------

  const posFilter = () => [...document.querySelectorAll('select')]
    .find((s) => /All Positions/i.test(s.options?.[0]?.text || ''));

  async function readPool() {
    const sel = posFilter();
    const prev = sel?.value;
    let total = 0;

    for (const [pos, depth] of CFG.POOL) {
      if (sel) {
        const opt = [...sel.options].find((o) => new RegExp(pos.replace(/\//g, '.'), 'i').test(o.text));
        if (opt) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(1200);
        }
      }
      // The table lazy-loads on scroll rather than paginating; scroll until the
      // row count stops growing or we have the depth we asked for.
      let seen = 0, stagnant = 0;
      while (seen < depth && stagnant < 3) {
        for (const p of readRows()) {
          if (!state.pool.has(p.id)) { state.pool.set(p.id, p); total++; }
        }
        const now = readRows().length;
        if (now <= seen) stagnant++; else stagnant = 0;
        seen = now;
        const tbl = playerTable();
        if (tbl) tbl.parentElement.scrollTop = tbl.parentElement.scrollHeight;
        await sleep(600);
      }
      say(`pool: ${pos} -> ${seen} rows seen`);
    }

    if (sel && prev !== undefined) {
      sel.value = prev;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    say(`pool read complete: ${total} players`);
    try { localStorage.setItem('ys_pool', JSON.stringify([...state.pool.values()]
      .map(({ row, ...p }) => p))); } catch (e) { /* private mode */ }
  }

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------

  let busy = false;
  async function tick() {
    if (busy || complete()) return;
    busy = true;
    try {
      dismissInactivityDialog();
      if (!state.armed) {
        if (!playerTable()) return;          // room not up yet
        await readPool();
        state.armed = true;
      }
      foldPicks();

      // THE RULE: during your turn we do nothing at all. You own the pick, and the
      // queue already holds the fallback if your clock runs out.
      if (myTurn()) return;

      if (queueCount() < CFG.QUEUE_TARGET) await refill();
    } catch (e) {
      say(`ERROR ${e.message}`);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, CFG.TICK_MS);
  window.__queueStop = () => { clearInterval(timer); say('stopped'); };
  window.__queueState = state;
  say(`armed — ${CFG.DRY_RUN ? 'DRY RUN' : 'LIVE'}, target ${CFG.QUEUE_TARGET}, slot ${CFG.SLOT}`);
})();
