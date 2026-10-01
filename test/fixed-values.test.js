'use strict';
// A source can set Channel / Partner for every row (partner institution tabs),
// or take Partner from a column (a direct sales tab).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { db } = h;
const { syncSource } = require('../src/sync/syncEngine');

const HEAD = ['Contact Name', 'School Name', 'City', 'Location', 'Board', 'Sales Person'];
test.before(async () => { await h.resetDb(); });
test.after(async () => { await db.close(); });

const schools = async () => Object.fromEntries((await db.query(`SELECT s.school_name, c.name AS channel, p.name AS partner
  FROM schools s LEFT JOIN channels c USING (channel_id) LEFT JOIN partners p USING (partner_id)`)).rows.map((r) => [r.school_name, r]));

test('fixed Channel and Partner apply to every row of a tab; Direct tab takes Partner from a column', async () => {
  h.writeSheet('partners', 'Shivaji University', [HEAD, ['Rutarth Shah', 'Atmiya Vidyalay', 'Vadodara', '', 'CBSE', 'Abhishek Mishra']]);
  h.writeSheet('partners', 'SL Team - Direct', [HEAD, ['A Rao', 'Sunrise Public School', 'Pune', '', 'CBSE', 'Abhishek Mishra']]);
  const shivaji = await h.addSource({ source_name: 'Shivaji University', spreadsheet_id: 'partners', sheet_name: 'Shivaji University', source_type: 'SCHOOL_MASTER',
    fixed_values: { channel: 'Institutions', partner: 'Shivaji University' } });
  const direct = await h.addSource({ source_name: 'SL Team - Direct', spreadsheet_id: 'partners', sheet_name: 'SL Team - Direct', source_type: 'SCHOOL_MASTER',
    fixed_values: { channel: 'Direct' }, column_mapping: { 'Sales Person': 'partner' } });
  for (const s of [shivaji, direct]) { const r = await syncSource(s.source_id, { triggeredBy: 'test' }); assert.equal(r.status, 'SUCCESS', r.message); }
  let k = await schools();
  assert.deepEqual([k['Atmiya Vidyalay'].channel, k['Atmiya Vidyalay'].partner], ['Institutions', 'Shivaji University']);
  assert.deepEqual([k['Sunrise Public School'].channel, k['Sunrise Public School'].partner], ['Direct', 'Abhishek Mishra']);

  // editing a fixed value re-applies rows that did not change in the sheet
  await db.query(`UPDATE data_sources SET fixed_values='{"channel":"Institutions","partner":"Shivaji Univ."}' WHERE source_id=$1`, [shivaji.source_id]);
  const r = await syncSource(shivaji.source_id, { triggeredBy: 'test' });
  assert.equal(r.rows_updated, 1, r.message);
  k = await schools();
  assert.equal(k['Atmiya Vidyalay'].partner, 'Shivaji Univ.');
});
