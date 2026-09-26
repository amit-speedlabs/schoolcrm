'use strict';
// Google Sheets API v4 adapter using a service account (JWT bearer flow).
// Implemented with Node's crypto + fetch so no credentials ever pass through
// third-party SDK code paths and nothing is exposed to the browser.
const crypto = require('crypto');
const fs = require('fs');
const config = require('../config');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

class SheetsError extends Error {
  constructor(message, { status, retryable } = {}) {
    super(message); this.status = status; this.retryable = !!retryable;
  }
}

function loadCredentials() {
  let raw = config.googleServiceAccountJson;
  if (!raw && config.googleServiceAccountFile) {
    if (!fs.existsSync(config.googleServiceAccountFile)) throw new SheetsError('GOOGLE_APPLICATION_CREDENTIALS file not found');
    raw = fs.readFileSync(config.googleServiceAccountFile, 'utf8');
  }
  if (!raw) throw new SheetsError('Google credentials are not configured (set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS)');
  if (!raw.trim().startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
  let creds;
  try { creds = JSON.parse(raw); } catch { throw new SheetsError('Google service account JSON is not valid JSON'); }
  if (!creds.client_email || !creds.private_key) throw new SheetsError('Service account JSON must contain client_email and private_key');
  return creds;
}

function isConfigured() {
  return !!(config.googleServiceAccountJson || config.googleServiceAccountFile);
}

let cachedToken = null; // { token, exp }
const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function getAccessToken() {
  if (cachedToken && cachedToken.exp - 60 > Date.now() / 1000) return cachedToken.token;
  const creds = loadCredentials();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: creds.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const signature = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claim}`), creds.private_key));
  const res = await fetchWithRetry(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${signature}` }),
  });
  const body = await res.json();
  cachedToken = { token: body.access_token, exp: now + (body.expires_in || 3600) };
  return cachedToken.token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries network errors, 429 and 5xx with exponential backoff (1s, 2s, 4s).
async function fetchWithRetry(url, opts, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      let msg = text;
      try { msg = JSON.parse(text).error?.message || JSON.parse(text).error_description || text; } catch { /* keep text */ }
      const retryable = res.status === 429 || res.status >= 500;
      lastErr = new SheetsError(`Google API ${res.status}: ${String(msg).slice(0, 300)}`, { status: res.status, retryable });
      if (!retryable) throw lastErr;
    } catch (e) {
      if (e instanceof SheetsError && !e.retryable) throw e;
      lastErr = e instanceof SheetsError ? e : new SheetsError(`Network error contacting Google: ${e.message}`, { retryable: true });
    }
    if (i < attempts - 1) await sleep(1000 * 2 ** i);
  }
  throw lastErr;
}

async function api(path, opts = {}) {
  const token = await getAccessToken();
  const res = await fetchWithRetry(`${API}/${path}`, {
    ...opts, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  return res.json();
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function colLetter(idx) { // 0-based -> A, B, ..., AA
  let s = ''; idx += 1;
  while (idx > 0) { const m = (idx - 1) % 26; s = String.fromCharCode(65 + m) + s; idx = Math.floor((idx - 1) / 26); }
  return s;
}

module.exports = {
  name: 'google',
  isConfigured,
  SheetsError,
  colLetter,

  async testConnection(source) {
    const meta = await api(`${encodeURIComponent(source.spreadsheet_id)}?fields=properties.title,sheets.properties.title`);
    const sheets = (meta.sheets || []).map((s) => s.properties.title);
    if (!sheets.includes(source.sheet_name)) {
      throw new SheetsError(`Connected to "${meta.properties.title}" but tab "${source.sheet_name}" was not found. Tabs: ${sheets.join(', ')}`);
    }
    return { ok: true, title: meta.properties.title, sheets };
  },

  // Returns { headers, rows: [{ rowNumber, values }] } using formatted values
  async readSheet(source) {
    const range = encodeURIComponent(`${q(source.sheet_name)}!A:ZZ`);
    const data = await api(`${encodeURIComponent(source.spreadsheet_id)}/values/${range}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`);
    const all = data.values || [];
    const h = (source.header_row || 1) - 1;
    const headers = (all[h] || []).map((x) => String(x ?? ''));
    const rows = [];
    for (let i = h + 1; i < all.length; i++) {
      const values = all[i] || [];
      if (values.every((v) => String(v ?? '').trim() === '')) continue;
      rows.push({ rowNumber: i + 1, values: values.map((v) => (v === undefined || v === null ? '' : String(v))) });
    }
    return { headers, rows };
  },

  // updates: [{ rowNumber, colIndex, value }]
  async writeCells(source, updates) {
    if (!updates.length) return 0;
    const data = updates.map((u) => ({
      range: `${q(source.sheet_name)}!${colLetter(u.colIndex)}${u.rowNumber}`,
      values: [[u.value]],
    }));
    for (let i = 0; i < data.length; i += 500) {
      await api(`${encodeURIComponent(source.spreadsheet_id)}/values:batchUpdate`, {
        method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: data.slice(i, i + 500) }),
      });
    }
    return updates.length;
  },
};
