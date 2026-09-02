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

  // Only the safety switches are set here. Slot and league size are DETECTED —
  // the slot from the draft-room URL and the team count from the draft-order
  // strip — and detection overrides config, so there is nothing to fill in.
  // Everything else keeps the defaults in queue-manager.user.js; setting them
  // here silently overrode that file, which is how the queue ran at 5 for a
  // while after the default became 10.
  window.YS_CONFIG = Object.assign({
    DRY_RUN: true,         // logs its intentions and touches nothing
    AUTOPICK_AT_SECONDS: 0,
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

    // The algorithm loads first: queue-manager.user.js refuses to start without a
    // strategy, rather than discovering one is missing mid-draft.
    (0, eval)(await get('strategy.js'));
    (0, eval)(await get('queue-manager.user.js'));
    log(`loaded — ${window.YS_CONFIG.DRY_RUN ? 'DRY RUN' : 'LIVE'}; slot and league size are detected from the room`);
  } catch (e) {
    log('FAILED: ' + e.message);
    log(`is the server running?  cd yahoo-football-draft-assistant && python3 serve.py`);
  }
})();
