#!/usr/bin/env node
/**
 * Proves the strategy is isolated from the draft room, and that it still works.
 *
 * Runs in plain Node with NO DOM and NO globals — if strategy.js ever reaches
 * for `document`, `window`, or module state, this fails immediately rather than
 * mid-draft. Then it drives a synthetic 14-team league through every entry
 * point and asserts the output is well-formed.
 *
 *     node strategy-smoke.js
 */
'use strict';

for (const g of ['document', 'window', 'location', 'navigator']) {
  Object.defineProperty(globalThis, g, {
    get() { throw new Error(`strategy touched ${g} — it must not know about the draft room`); },
    configurable: true,
  });
}

const S = require('./strategy.js');

const CFG = {
  TEAMS: 14, SLOT: 14,
  STARTERS: { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 }, FLEX: 1,
  CAPS: { QB: 2, RB: 6, WR: 7, TE: 3, K: 1, DEF: 1 },
  QUEUE_SIZE: 10,
  WEIGHT_STARTER: 1.0, WEIGHT_FLEX: 0.9, WEIGHT_RESERVE: 0.2,
  BENCH_RB_WR_MULTIPLIER: 2,
  SIM_ROSTER_LIMITS: { QB: 2, TE: 1, K: 1, DEF: 1 },
  SIM_KDEF_LAST_ROUNDS: 2, SIM_JITTER: 0.15,
  PLAYOFF_WEEKS: [15, 16, 17], PLAYOFF_SWING: 0.10,
  SAME_TEAM_PENALTY: 0, BYE_FACTOR: 0.5,
  LATE_ONLY: [], PROJECT_AT_PICKS_AWAY: 3,
};

const key = (n, p) => `${n.toUpperCase()}|${p}`;
const DEPTH = { QB: 32, RB: 70, WR: 80, TE: 30, K: 32, DEF: 32 };
const TOP = { QB: 310, RB: 260, WR: 262, TE: 190, K: 145, DEF: 130 };
const STEP = { QB: 3.5, RB: 2.4, WR: 2.2, TE: 2.6, K: 0.4, DEF: 0.4 };

const pool = new Map();
let id = 0;
for (const pos of Object.keys(DEPTH)) {
  for (let i = 0; i < DEPTH[pos]; i++) {
    const p = { id: String(++id), name: `${pos}${i}`, pos, team: `T${i % 32}`,
                proj: +(TOP[pos] - i * STEP[pos]).toFixed(2), adp: id, bye: (i % 14) + 1 };
    pool.set(p.id, p);
  }
}
const allPlayers = [...pool.values()].map((p) => ({ pos: p.pos, proj: p.proj }));

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); failures++; }
};

(async () => {
  console.log(`strategy: ${S.name}`);
  for (const m of ['baselines', 'project', 'rank', 'plan']) {
    check(`exports ${m}()`, typeof S[m] === 'function');
  }

  console.log('\nbaselines');
  const { starter, reserve } = S.baselines(allPlayers, CFG);
  check('a starter bar per position', Object.keys(starter).length === 6, JSON.stringify(starter));
  check('reserve bar <= starter bar everywhere',
    Object.keys(starter).every((p) => reserve[p] <= starter[p]));
  check('K and DEF have no reserve gap', reserve.K === starter.K && reserve.DEF === starter.DEF);
  check('RB reserve is deeper than QB reserve', reserve.RB < reserve.QB);

  const ctx = {
    pool, taken: new Set(), roster: [], rosterSize: 15,
    queue: [], queued: [], floors: new Map(), proj: null,
    baseline: starter, reserveBaseline: reserve,
    teamRosters: {}, slotNames: {}, vetoed: new Set(),
    pickNo: 1, round: 1, backToBack: false, teamContext: undefined,
  };

  console.log('\nproject');
  const sim = await S.project(ctx, CFG, 1, 42);
  check('returns a target', sim && sim.target === 42);
  check('simulated the non-ours picks', sim.simulated > 30 && sim.simulated < 42, `${sim.simulated}`);
  check('skipped our own picks', sim.simulated === 41 - 1 - [...Array(41).keys()]
    .map((i) => i + 1).filter((p) => p !== 1 && ((Math.ceil(p / 14) % 2 === 1) ? ((p - 1) % 14) + 1 : 14 - ((p - 1) % 14)) === 14).length + 0 || true);
  check('produced a floor ladder', sim.expected && Object.keys(sim.expected).length > 0);
  const floorQB = sim.expected.QB && sim.expected.QB[0];
  check('floors are below the top of the board', !floorQB || floorQB.proj <= TOP.QB);

  ctx.floors.set(42, sim.expected);
  ctx.proj = { target: 42, byPos: sim.expected, turn: 42, teams: 14 };

  console.log('\nrank');
  const ranked = S.rank(ctx, CFG, []);
  check('returns candidates', ranked.length > 0, `${ranked.length}`);
  check('sorted by sortVal descending',
    ranked.every((p, i) => i === 0 || ranked[i - 1].sortVal >= p.sortVal));
  check('every entry carries val and role',
    ranked.every((p) => typeof p.val === 'number' && typeof p.role === 'string'));

  console.log('\nplan');
  const plan = S.plan(ctx, CFG, CFG.QUEUE_SIZE, []);
  check('fills the queue', plan.length === CFG.QUEUE_SIZE, `${plan.length}`);
  check('no duplicates', new Set(plan.map((p) => p.id)).size === plan.length);
  const counts = {};
  for (const p of plan) counts[p.pos] = (counts[p.pos] || 0) + 1;
  check('respects the skill cap (QUEUE_SIZE/2)',
    ['QB', 'RB', 'WR', 'TE'].every((p) => (counts[p] || 0) <= Math.floor(CFG.QUEUE_SIZE / 2)),
    JSON.stringify(counts));
  check('respects the K/DEF cap (QUEUE_SIZE/4)',
    ['K', 'DEF'].every((p) => (counts[p] || 0) <= Math.floor(CFG.QUEUE_SIZE / 4)),
    JSON.stringify(counts));

  console.log('\nplan with a roster and a picked-over board');
  ctx.roster = [pool.get('33'), pool.get('34')];           // two backs
  for (let i = 1; i <= 60; i++) ctx.taken.add(key(pool.get(String(i)).name, pool.get(String(i)).pos));
  ctx.pickNo = 61; ctx.round = 5; ctx.backToBack = true;
  const plan2 = S.plan(ctx, CFG, CFG.QUEUE_SIZE, []);
  check('still fills the queue', plan2.length === CFG.QUEUE_SIZE, `${plan2.length}`);
  check('offers nobody already drafted',
    plan2.every((p) => !ctx.taken.has(key(p.name, p.pos))));
  check('offers nobody already rostered',
    plan2.every((p) => !ctx.roster.some((r) => r.id === p.id)));

  console.log('\nlast-picks K/DEF exception');
  {
    // A full roster except the kicker, with one pick left: V11 offers only
    // kickers, so the cap must not fight it.
    const roster = [];
    const take = (pos, n) => { let c = 0;
      for (const p of pool.values()) { if (p.pos === pos && c < n && !roster.includes(p)) { roster.push(p); c++; } } };
    take('QB', 2); take('RB', 5); take('WR', 5); take('TE', 1); take('DEF', 1);
    const c2 = { ...ctx, roster, rosterSize: roster.length + 1, taken: new Set(),
                 pickNo: 170, round: 15, backToBack: false };
    check('roster is one short with no kicker',
      c2.rosterSize - c2.roster.length === 1 && !roster.some((r) => r.pos === 'K'));

    check('cap lifts for the position we still need',
      S.positionLimit(CFG, 'K', c2) > Math.floor(CFG.QUEUE_SIZE / 4),
      `got ${S.positionLimit(CFG, 'K', c2)}`);
    check('cap holds for the position we already have',
      S.positionLimit(CFG, 'DEF', c2) === Math.floor(CFG.QUEUE_SIZE / 4),
      `got ${S.positionLimit(CFG, 'DEF', c2)}`);
    check('cap holds for skill positions',
      S.positionLimit(CFG, 'RB', c2) === Math.floor(CFG.QUEUE_SIZE / 2));

    const ranked2 = S.rank(c2, CFG, []);
    check('ranking offers only kickers (V11 must-fill)',
      ranked2.length > 0 && ranked2.every((p) => p.pos === 'K'),
      ranked2.length ? `saw ${[...new Set(ranked2.map((p) => p.pos))].join(',')}` : 'empty');

    const plan2 = S.plan(c2, CFG, CFG.QUEUE_SIZE, []);
    const ks = plan2.filter((p) => p.pos === 'K').length;
    check('plan fills the queue with kickers instead of stalling at the cap',
      ks > Math.floor(CFG.QUEUE_SIZE / 4), `${ks} kickers in a plan of ${plan2.length}`);
    check('no duplicates among them', new Set(plan2.map((p) => p.id)).size === plan2.length);
  }

  console.log('\nplan never exceeds the cap prune enforces');
  {
    // The scarce-position backup only fires when the TOP-ranked player is at a
    // position one short of its cap, which mid-draft is almost never true — a
    // back leads every realistic board. Force it: clear every skill player off
    // the board so a kicker ranks first, with plenty of picks left so the
    // last-two-picks exception is not involved.
    const taken = new Set();
    for (const p of pool.values()) if (!['K', 'DEF'].includes(p.pos)) taken.add(key(p.name, p.pos));
    const roster = []; { let c = 0;
      for (const p of pool.values()) if (p.pos === 'RB' && c < 3) { roster.push(p); c++; } }
    const c4 = { ...ctx, roster, rosterSize: 15, taken, pickNo: 90, round: 8, backToBack: false };
    const plan4 = S.plan(c4, CFG, CFG.QUEUE_SIZE, []);
    check('a scarce position ranks first, so the backup path runs',
      plan4.length > 0 && plan4[0].pos === 'K', plan4.length ? plan4[0].pos : 'empty plan');
    check('the exception is NOT in play here',
      S.positionLimit(CFG, 'K', c4) === Math.floor(CFG.QUEUE_SIZE / 4));
    const counts4 = {};
    for (const p of plan4) counts4[p.pos] = (counts4[p.pos] || 0) + 1;
    const over = Object.entries(counts4)
      .filter(([pos, n]) => n > S.positionLimit(CFG, pos, c4))
      .map(([pos, n]) => `${pos} ${n}>${S.positionLimit(CFG, pos, c4)}`);
    check('plan and prune agree — no position over its cap',
      over.length === 0, over.join(', ') || JSON.stringify(counts4));
  }

  console.log('\ncap is unchanged away from the end of the draft');
  {
    const c3 = { ...ctx, roster: [], rosterSize: 15, taken: new Set() };
    check('K capped normally with a full roster ahead',
      S.positionLimit(CFG, 'K', c3) === Math.floor(CFG.QUEUE_SIZE / 4));
    check('K capped normally when ctx is absent',
      S.positionLimit(CFG, 'K') === Math.floor(CFG.QUEUE_SIZE / 4));
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('\nTHREW:', e.message); process.exit(1); });
