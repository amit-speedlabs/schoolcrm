'use strict';
// Test harness: isolated database + temp fixture "sheets" + an HTTP client with a session.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), 'glf-sheets-'));
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/glf_crm_test';
process.env.FIXTURE_DIR = FIXTURES;
process.env.SYNC_SCHEDULER = 'false';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '';
process.env.GOOGLE_APPLICATION_CREDENTIALS = '';

const db = require('../src/db');
const { createApp } = require('../src/server');
const { hashPassword } = require('../src/auth');
const { toCsv, parseCsv } = require('../src/sheets/fixtureAdapter');

async function resetDb() {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate(() => {});
}

function writeSheet(book, sheet, rows) {
  fs.mkdirSync(path.join(FIXTURES, book), { recursive: true });
  fs.writeFileSync(path.join(FIXTURES, book, `${sheet}.csv`), toCsv(rows));
}
function readSheet(book, sheet) { return parseCsv(fs.readFileSync(path.join(FIXTURES, book, `${sheet}.csv`), 'utf8')); }
function setOutage(book, sheet, on, msg = 'Google Sheets unavailable (503)') {
  const f = path.join(FIXTURES, book, `${sheet}.FAIL`);
  if (on) fs.writeFileSync(f, msg); else if (fs.existsSync(f)) fs.unlinkSync(f);
}

async function addSource(fields) {
  const cols = Object.keys(fields);
  const { rows } = await db.query(`INSERT INTO data_sources (adapter, ${cols.join(',')}) VALUES ('fixture', ${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, cols.map((k) => fields[k]));
  return rows[0];
}

async function createLogin(email, password, role) {
  await db.query(`INSERT INTO users (name, email, access_role, password_hash, role) VALUES ($1,$2,$3,$4,$3)`, [email.split('@')[0], email, role, hashPassword(password)]);
}

async function startServer() {
  const app = createApp();
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

function client(base) {
  let cookie = '';
  const req = async (method, p, body, { raw = false, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method, headers: { 'content-type': 'application/json', 'x-requested-with': 'glf-crm', cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    if (raw) return res;
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
  return {
    get: (p, o) => req('GET', p, null, o), post: (p, b, o) => req('POST', p, b, o), patch: (p, b, o) => req('PATCH', p, b, o),
    login: (email, password) => req('POST', '/api/auth/login', { email, password }),
  };
}

module.exports = { db, resetDb, writeSheet, readSheet, setOutage, addSource, createLogin, startServer, client, FIXTURES };
