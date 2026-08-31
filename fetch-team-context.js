#!/usr/bin/env node
/**
 * Reads NFL team strength and the full season schedule from ESPN, joins them,
 * and derives the strength-of-schedule numbers that matter for drafting.
 *
 *   node fetch-team-context.js [--out team-context.json]
 *
 * Run this any time before the draft — it is static preseason data and has no
 * dependency on a draft room being open. No npm packages; Node 18+ only.
 *
 * Sources (both server-rendered, no API key):
 *   https://www.espn.com/nfl/fpi           Football Power Index, one row per team
 *   https://www.espn.com/nfl/schedulegrid  32 x 18 grid of opponents
 */

// Identify honestly as a script. Counter-intuitively this is also what WORKS:
// claiming to be Chrome gets a JS bot-challenge page (~2KB) instead of the real
// HTML, because ESPN expects a browser-shaped client to execute the challenge.
const UA = 'yahoo-football-draft-assistant (+https://github.com/jdfree/yahoo-football-draft-assistant)';

const FPI_URL = 'https://www.espn.com/nfl/fpi';
const GRID_URL = 'https://www.espn.com/nfl/schedulegrid';

// ESPN is not internally consistent about a few abbreviations: the FPI table and
// the schedule grid disagree. Normalize everything to the FPI spelling.
const ALIAS = { WAS: 'WSH', LA: 'LAR', JAC: 'JAX', TAM: 'TB', NOR: 'NO', KAN: 'KC',
                SFO: 'SF', GNB: 'GB', NWE: 'NE', LVR: 'LV' };
const norm = (t) => ALIAS[t] || t;

async function get(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const html = await r.text();
  if (html.length < 50000) {
    throw new Error(`${url} returned ${html.length} bytes — that is ESPN's bot challenge, ` +
                    `not the page. Do not send a browser user-agent.`);
  }
  return html;
}

/** FPI lives in ESPN's embedded __espnfitt__ state blob, not in the markup. */
function parseFPI(html) {
  const m = html.match(/window\[.__espnfitt__.\]\s*=\s*(\{.*?\});<\/script>/s);
  if (!m) throw new Error('FPI: __espnfitt__ state not found — page structure changed');
  const rows = JSON.parse(m[1])?.page?.content?.table?.stats;
  if (!Array.isArray(rows) || !rows.length) throw new Error('FPI: no stats rows in state');

  const teams = {};
  for (const row of rows) {
    const stat = (n) => row.stats.find((s) => s.name === n)?.value;
    const num = (n) => { const v = parseFloat(stat(n)); return Number.isFinite(v) ? v : null; };
    teams[norm(row.team.abbrev)] = {
      abbrev: norm(row.team.abbrev),
      name: row.team.displayName,
      fpi: num('fpi'),
      fpiRank: num('fpirank'),
      epaOffense: num('epaoffense'),
      epaDefense: num('epadefense'),
      epaSpecialTeams: num('epaspecialteams'),
      sosRank: num('avgsosrank'),
    };
  }
  return teams;
}

/** Schedule grid is a plain HTML table: one row per team, one column per week. */
function parseSchedule(html) {
  const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
                        .replace(/\s+/g, ' ').trim();
  const rows = [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)]
    .map((m) => [...m[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map((c) => strip(c[1])))
    .filter((c) => c.length > 2);

  const header = rows.find((c) => /^TEAM$/i.test(c[0]));
  if (!header) throw new Error('schedule: header row not found — page structure changed');
  const weeks = header.slice(1).map(Number).filter(Number.isInteger);

  const schedule = {};
  for (const cells of rows) {
    const team = norm(cells[0].toUpperCase());
    if (!/^[A-Z]{2,3}$/.test(team) || team === 'TEAM') continue;
    schedule[team] = cells.slice(1, weeks.length + 1).map((cell, i) => {
      const week = weeks[i];
      if (!cell || /^BYE$/i.test(cell)) return { week, bye: true };
      const away = cell.startsWith('@');
      return { week, opponent: norm(cell.replace(/^@/, '').toUpperCase()), home: !away };
    });
  }
  return schedule;
}

/**
 * Strength of schedule as mean opponent FPI. Higher = harder.
 * Fantasy playoffs default to weeks 15-17; override with --playoffs 15,16,17.
 */
function derive(teams, schedule, playoffWeeks) {
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);

  for (const [abbr, games] of Object.entries(schedule)) {
    const t = teams[abbr];
    if (!t) continue;
    const oppFpi = (gs) => gs.filter((g) => !g.bye)
      .map((g) => teams[g.opponent]?.fpi).filter((v) => Number.isFinite(v));

    t.byeWeek = games.find((g) => g.bye)?.week ?? null;
    t.sosSeason = r2(mean(oppFpi(games)));
    t.sosPlayoffs = r2(mean(oppFpi(games.filter((g) => playoffWeeks.includes(g.week)))));
    t.schedule = games;
  }

  // Rank 1 = easiest schedule, so a high-FPI team faces weak opponents.
  const ranked = Object.values(teams).filter((t) => t.sosSeason !== null)
    .sort((a, b) => a.sosSeason - b.sosSeason);
  ranked.forEach((t, i) => { t.sosSeasonRank = i + 1; });
  const rankedPo = Object.values(teams).filter((t) => t.sosPlayoffs !== null)
    .sort((a, b) => a.sosPlayoffs - b.sosPlayoffs);
  rankedPo.forEach((t, i) => { t.sosPlayoffsRank = i + 1; });

  return teams;
}

/**
 * A silent mis-parse is the real risk here, not a crash. Check the things that
 * must be true of any NFL season: 272 games, one bye each, and every matchup
 * reciprocated with opposite home/away.
 */
function validate(teams) {
  const problems = [];
  const names = Object.keys(teams);
  for (const t of names) {
    const games = teams[t].schedule || [];
    if (games.length !== 18) problems.push(`${t}: ${games.length} weeks, expected 18`);
    const byes = games.filter((g) => g.bye).length;
    if (byes !== 1) problems.push(`${t}: ${byes} bye weeks, expected 1`);
    for (const g of games.filter((g) => !g.bye)) {
      const back = teams[g.opponent]?.schedule?.find((y) => y.week === g.week);
      if (!back || back.bye || back.opponent !== t) {
        problems.push(`${t} wk${g.week} vs ${g.opponent}: not reciprocated`);
      } else if (back.home === g.home) {
        problems.push(`${t} wk${g.week} vs ${g.opponent}: both listed home=${g.home}`);
      }
    }
  }
  const games = names.flatMap((t) => teams[t].schedule.filter((g) => !g.bye)).length / 2;
  if (games !== 272) problems.push(`${games} games total, expected 272`);
  if (problems.length) {
    throw new Error(`schedule failed validation (${problems.length} problems):\n  ` +
                    problems.slice(0, 10).join('\n  '));
  }
  return games;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const out = arg('--out', 'team-context.json');
  const playoffWeeks = arg('--playoffs', '15,16,17').split(',').map(Number);

  const [fpiHtml, gridHtml] = await Promise.all([get(FPI_URL), get(GRID_URL)]);
  const teams = parseFPI(fpiHtml);
  const schedule = parseSchedule(gridHtml);

  // Fail loudly rather than silently producing a partial table.
  const missing = Object.keys(teams).filter((t) => !schedule[t]);
  const extra = Object.keys(schedule).filter((t) => !teams[t]);
  if (Object.keys(teams).length !== 32) throw new Error(`FPI returned ${Object.keys(teams).length} teams, expected 32`);
  if (missing.length || extra.length) {
    throw new Error(`abbreviation mismatch between sources — add to ALIAS.\n` +
                    `  in FPI only: ${missing.join(', ') || 'none'}\n` +
                    `  in grid only: ${extra.join(', ') || 'none'}`);
  }

  derive(teams, schedule, playoffWeeks);
  const games = validate(teams);

  const payload = {
    fetchedAt: new Date().toISOString(),
    sources: { fpi: FPI_URL, schedule: GRID_URL },
    playoffWeeks,
    teams,
  };
  await require('fs').promises.writeFile(out, JSON.stringify(payload, null, 2));

  const list = Object.values(teams).sort((a, b) => a.fpiRank - b.fpiRank);
  console.log(`Wrote ${out} — ${list.length} teams, ${games} games validated, ` +
              `weeks ${playoffWeeks.join('/')} as fantasy playoffs\n`);
  console.log('Rank Team  FPI    Bye  SoS(season)  SoS(playoffs)');
  for (const t of list.slice(0, 10)) {
    console.log(
      String(t.fpiRank).padStart(3), t.abbrev.padEnd(4),
      String(t.fpi).padStart(5), String(t.byeWeek ?? '-').padStart(4),
      `${String(t.sosSeason).padStart(7)} (#${t.sosSeasonRank})`.padStart(14),
      `${String(t.sosPlayoffs).padStart(6)} (#${t.sosPlayoffsRank})`.padStart(15));
  }
  console.log('  … full table in ' + out);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
