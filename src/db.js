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
  await lockDownPublicApi(log);
}

// Supabase exposes the public schema through its Data API (anon / authenticated roles). The CRM never uses that API:
// it connects to Postgres directly as the owner of its tables, and an owner is not subject to Row-Level Security.
// So: RLS on (with no policies) for every table this role owns, and no table grants for the API roles.
// Runs on every start, so tables added by later migrations are covered too.
async function lockDownPublicApi(log = console.log) {
  const { rows } = await query(`SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity AND pg_get_userbyid(c.relowner) = current_user`);
  for (const r of rows) await query(`ALTER TABLE public.${quoteIdent(r.relname)} ENABLE ROW LEVEL SECURITY`);
  if (rows.length) log(`[db] row-level security enabled on ${rows.length} table(s)`);
  const { rows: roles } = await query(`SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`);
  for (const { rolname } of roles) {
    await query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${rolname}`);
    await query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${rolname}`);
  }
}
const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { query, tx, migrate, close, getPool, lockDownPublicApi };
