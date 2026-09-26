'use strict';
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const config = require('./config');

// Return DATE columns as 'YYYY-MM-DD' strings (no timezone shifting)
types.setTypeParser(1082, (v) => v);
// BIGINT counts -> JS numbers (our counts never approach 2^53)
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
      max: 10,
    });
    pool.on('error', (e) => console.error('[db] idle client error', e.message));
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function migrate(log = console.log) {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await query('SELECT name FROM schema_migrations');
  const done = new Set(rows.map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await tx(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    log(`[db] applied migration ${f}`);
  }
}

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { query, tx, migrate, close, getPool };
