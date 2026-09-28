'use strict';
const ExcelJS = require('exceljs');
const { listSchools } = require('./schools');

const COLUMNS = [
  ['School ID', 'school_id'], ['School Name', 'school_name'], ['State', 'state'], ['District', 'district'], ['City', 'city'],
  ['Address', 'address'], ['PIN Code', 'pin_code'], ['Board', 'board'],
  ['Principal', 'principal_name'], ['Principal Contact', 'principal_contact'], ['School Email', 'school_email'],
  ['Coordinator', 'coordinator_name'], ['Coordinator Phone', 'coordinator_phone'],
  ['Channel', 'channel'], ['Partner', 'partner'], ['Sales SPOC', 'sales_spoc'],
  ['Kit Given', (r) => (r.kit_given ? 'YES' : 'NO')], ['Kit Drop Date', 'kit_drop_date'], ['No of Kits', 'number_of_kits'],
  ['School Registered', (r) => (r.school_registered ? 'YES' : 'NO')], ['Registration Date', 'registration_date'],
  ['Grade 3', 'grade_3'], ['Grade 4', 'grade_4'], ['Grade 5', 'grade_5'], ['Grade 6', 'grade_6'],
  ['Grade 7', 'grade_7'], ['Grade 8', 'grade_8'], ['Grade 9', 'grade_9'], ['Grade 10', 'grade_10'], ['Grade not specified', 'ungraded'],
  ['Total Students', 'total_students'], ['Source Sheet', 'source_sheet'], ['Source Row', 'source_row'],
  ['Last Synced', (r) => (r.last_synced_at ? new Date(r.last_synced_at).toISOString() : '')],
  ['Demo Data', (r) => (r.is_demo ? 'DEMO' : '')],
];
const cell = (r, get) => { const v = typeof get === 'function' ? get(r) : r[get]; return v === null || v === undefined ? '' : v; };
const csvEsc = (v) => { const s = String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };

function describeFilters(f) {
  return Object.entries(f).filter(([k, v]) => v && !['format', 'sort', 'dir', 'page', 'pageSize'].includes(k)).map(([k, v]) => `${k}=${v}`);
}

async function exportSchools(f, format, { sort, dir } = {}) {
  const { rows } = await listSchools(f, { all: true, sort, dir });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'GLF AI Olympiad CRM';
    const ws = wb.addWorksheet('Schools');
    ws.columns = COLUMNS.map(([h]) => ({ header: h, width: Math.max(12, h.length + 2) }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of rows) ws.addRow(COLUMNS.map(([, g]) => cell(r, g)));
    const meta = wb.addWorksheet('Export Info');
    meta.addRow(['Exported at', new Date().toISOString()]);
    meta.addRow(['Rows', rows.length]);
    meta.addRow(['Filters', describeFilters(f).join('; ') || '(none)']);
    if (rows.some((r) => r.is_demo)) meta.addRow(['NOTE', 'Contains DEMO DATA']);
    return { body: await wb.xlsx.writeBuffer(), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `glf-schools-${stamp}.xlsx`, count: rows.length };
  }
  const lines = [COLUMNS.map(([h]) => csvEsc(h)).join(',')];
  for (const r of rows) lines.push(COLUMNS.map(([, g]) => csvEsc(cell(r, g))).join(','));
  return { body: '﻿' + lines.join('\r\n') + '\r\n', type: 'text/csv; charset=utf-8', filename: `glf-schools-${stamp}.csv`, count: rows.length };
}

module.exports = { exportSchools, COLUMNS };
