/**
 * Loader for the draft assistant. No browser extension required.
 *
 * The Yahoo draft room sends no Content-Security-Policy, so the page can fetch
 * and evaluate this from anywhere — including http://localhost, which Chrome
 * treats as a trustworthy origin even on an HTTPS page.
 *
 * Run it from a bookmarklet, or paste it into DevTools once per draft:
 *
 *   javascript:(function(){var s=document.createElement('script');
 *   s.src='http://localhost:8765/bootstrap.js';document.body.appendChild(s);})()
 *
 * Set YS_CONFIG first to override anything in the script's CFG block.
 */
(async function () {
  const BASE = (window.YS_BASE || 'http://localhost:8765').replace(/\/$/, '');
  const log = (m) => console.log('[assistant loader]', m);

  if (window.__queueStop) { window.__queueStop(); log('stopped previous instance'); }

  window.YS_CONFIG = Object.assign({
    SLOT: 1,               // your ACTUAL slot — check the waiting room
    TEAMS: 12,
    QUEUE_SIZE: 5,
    DRY_RUN: true,         // flip to false once a dry run reads clean
    AUTOPICK_AT_SECONDS: 0,
    SHOW_OVERLAY: true,
  }, window.YS_CONFIG || {});

  const get = async (path) => {
    const r = await fetch(`${BASE}/${path}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
    return r.text();
  };

  try {
    // Playoff modifiers first — the assistant reads window.YS_TEAM_CONTEXT.
    try { (0, eval)(await get('team-context.gen.js')); log('team context loaded'); }
    catch (e) { log('no team context (' + e.message + ') — playoff modifier will be 1.0'); }

    (0, eval)(await get('queue-manager.user.js'));
    log(`armed — slot ${window.YS_CONFIG.SLOT}, ${window.YS_CONFIG.DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  } catch (e) {
    log('FAILED: ' + e.message);
    log(`is the server running?  cd yahoo-football-draft-assistant && python3 serve.py`);
  }
})();
