'use strict';
// Loads clearly-labelled DEMO DATA by syncing the CSV "sheets" in fixtures/demo through
// the same integration pipeline used for Google Sheets (mapping, matching, School IDs,
// write-back, review queue). Refuses to run when production (non-demo) schools exist.
// Usage: node scripts/seed-demo.js [--force]
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const db = require('../src/db');
const { hashPassword } = require('../src/auth');
const { syncAll } = require('../src/sync/syncEngine');

const SOURCES = [
  { source_name: 'DEMO - School Master', sheet_name: 'School Master', source_type: 'SCHOOL_MASTER', writeback_enabled: true },
  { source_name: 'DEMO - Kit Distribution', sheet_name: 'Kit Distribution', source_type: 'KIT_DISTRIBUTION' },
  { source_name: 'DEMO - School Registration', sheet_name: 'School Registration', source_type: 'SCHOOL_REGISTRATION' },
  { source_name: 'DEMO - Student Registration (Form responses)', sheet_name: 'Student Registration', source_type: 'STUDENT_REGISTRATION', student_mode: 'LATEST' },
];

(async () => {
  await db.migrate(() => {});
  const { rows: [c] } = await db.query('SELECT count(*)::int AS n FROM schools WHERE NOT is_demo');
  if (c.n > 0 && !process.argv.includes('--force')) {
    throw new Error(`Refusing to load demo data: ${c.n} production schools exist. Demo data must not be mixed with production data.`);
  }
  // fresh copy of the demo "sheets" (write-back modifies them)
  const src = path.join(__dirname, '..', 'fixtures', 'demo');
  const dst = path.join(config.fixtureDir, 'demo');
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));

  for (const s of SOURCES) {
    const { rows } = await db.query('SELECT source_id FROM data_sources WHERE source_name=$1', [s.source_name]);
    if (rows[0]) continue;
    await db.query(
      `INSERT INTO data_sources (source_name, adapter, spreadsheet_id, sheet_name, source_type, writeback_enabled, student_mode, is_demo, sync_frequency_minutes)
       VALUES ($1,'fixture','demo',$2,$3,$4,$5,TRUE,60)`,
      [s.source_name, s.sheet_name, s.source_type, !!s.writeback_enabled, s.student_mode || 'LATEST']);
  }
  const logins = [
    ['Demo Admin', 'admin@glf-demo.local', 'DemoAdmin@2026', 'ADMIN'],
    ['Demo Management', 'management@glf-demo.local', 'DemoView@2026', 'MANAGEMENT'],
  ];
  for (const [name, email, pw, role] of logins) {
    await db.query(
      `INSERT INTO users (name, email, role, team, access_role, password_hash, created_via, is_demo) VALUES ($1,$2,$4,'Management',$4,$3,'BOOTSTRAP',TRUE)
       ON CONFLICT (lower(email)) WHERE email IS NOT NULL DO NOTHING`, [name, email, hashPassword(pw), role]);
  }
  const results = await syncAll({ triggeredBy: 'seed-demo' });
  for (const r of results) console.log(`${r.source_name}: ${r.status} - ${r.message}`);
  console.log('\nDEMO logins:\n  admin@glf-demo.local / DemoAdmin@2026 (ADMIN)\n  management@glf-demo.local / DemoView@2026 (MANAGEMENT)');
  await db.close();
})().catch(async (e) => { console.error(e.message); await db.close(); process.exit(1); });
