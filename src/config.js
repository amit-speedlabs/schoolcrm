'use strict';
// Central configuration. Everything sensitive comes from environment variables;
// nothing here is ever sent to the browser.
const fs = require('fs');
const path = require('path');

// Minimal .env loader (no dependency). Real env vars win over .env values.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(__dirname, '..', '.env'));

const env = process.env;
module.exports = {
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL || 'postgres://postgres@localhost:5432/glf_crm',
  databaseSsl: env.DATABASE_SSL === 'true',
  sessionTtlHours: Number(env.SESSION_TTL_HOURS || 12),
  cookieSecure: env.COOKIE_SECURE === 'true',
  // Google service account: either inline JSON (optionally base64) or a file path
  googleServiceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
  googleServiceAccountFile: env.GOOGLE_APPLICATION_CREDENTIALS || '',
  schedulerEnabled: env.SYNC_SCHEDULER !== 'false',
  schedulerTickSeconds: Number(env.SYNC_TICK_SECONDS || 60),
  fixtureDir: env.FIXTURE_DIR || path.join(__dirname, '..', 'var', 'fixtures'),
  bootstrapAdmin: {
    email: env.ADMIN_EMAIL || '',
    password: env.ADMIN_PASSWORD || '',
    name: env.ADMIN_NAME || 'Administrator',
  },
  timezone: env.APP_TIMEZONE || 'Asia/Kolkata',
};
