'use strict';
// Periodic sync. Each tick syncs every enabled source that is due (per its
// sync_frequency_minutes, with backoff retries after failures). Errors never crash the app.
const config = require('../config');
const { syncAll } = require('./syncEngine');

let timer = null; let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const results = await syncAll({ triggeredBy: 'scheduler', onlyDue: true });
    for (const r of results) console.log(`[sync] ${r.source_name}: ${r.status} ${r.message || ''}`);
  } catch (e) {
    console.error('[sync] scheduler tick failed:', e.message);
  } finally { running = false; }
}
function start() {
  if (timer || !config.schedulerEnabled) return;
  timer = setInterval(tick, config.schedulerTickSeconds * 1000);
  timer.unref();
  setTimeout(tick, 5000).unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }
module.exports = { start, stop, tick };
