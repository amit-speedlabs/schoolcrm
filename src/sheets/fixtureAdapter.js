'use strict';
// CSV-backed stand-in for Google Sheets, used for DEMO data and automated tests.
// spreadsheet_id "demo" + sheet_name "School Master" -> fixtures/demo/School Master.csv
// It supports the same operations as the Google adapter, including write-back,
// and can simulate an outage: create a file named "<sheet>.FAIL" next to the CSV.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { SheetsError } = require('./googleAdapter');

function fileFor(source) {
  const safe = (s) => String(s).replace(/[^A-Za-z0-9 _.-]/g, '_');
  return path.join(config.fixtureDir, safe(source.spreadsheet_id), `${safe(source.sheet_name)}.csv`);
}

function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const csvCell = (v) => (/[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
function toCsv(rows) { return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n'; }

function checkFail(source) {
  const f = fileFor(source).replace(/\.csv$/, '.FAIL');
  if (fs.existsSync(f)) throw new SheetsError(`Simulated outage: ${fs.readFileSync(f, 'utf8').trim() || 'Google Sheets unavailable (503)'}`, { status: 503, retryable: true });
}

module.exports = {
  name: 'fixture',
  isConfigured: () => true,
  parseCsv, toCsv, fileFor,

  async testConnection(source) {
    checkFail(source);
    const f = fileFor(source);
    if (!fs.existsSync(f)) throw new SheetsError(`Fixture sheet not found: ${path.relative(config.fixtureDir, f)}`);
    return { ok: true, title: `Fixture: ${source.spreadsheet_id}`, sheets: [source.sheet_name] };
  },

  async readSheet(source) {
    checkFail(source);
    const f = fileFor(source);
    if (!fs.existsSync(f)) throw new SheetsError(`Fixture sheet not found: ${path.relative(config.fixtureDir, f)}`);
    const all = parseCsv(fs.readFileSync(f, 'utf8'));
    const h = (source.header_row || 1) - 1;
    const headers = all[h] || [];
    const rows = [];
    for (let i = h + 1; i < all.length; i++) {
      if (all[i].every((v) => String(v).trim() === '')) continue;
      rows.push({ rowNumber: i + 1, values: all[i] });
    }
    return { headers, rows };
  },

  async writeCells(source, updates) {
    checkFail(source);
    const f = fileFor(source);
    const all = parseCsv(fs.readFileSync(f, 'utf8'));
    for (const u of updates) {
      while (all.length < u.rowNumber) all.push([]);
      const r = all[u.rowNumber - 1];
      while (r.length <= u.colIndex) r.push('');
      r[u.colIndex] = u.value;
    }
    const width = Math.max(...all.map((r) => r.length));
    all.forEach((r) => { while (r.length < width) r.push(''); });
    fs.writeFileSync(f, toCsv(all));
    return updates.length;
  },
};
