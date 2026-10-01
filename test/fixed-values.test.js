'use strict';
// A source can set Channel / Partner for every row (partner institution tabs),
// or take Partner from a column (a direct sales tab).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { db } = h;
const { syncSource } = require('../src/sync/syncEngine');

// header rows as they are in the live tabs
const INST = ['Timestamp', 'Name of the School', 'School Address', 'School Board', 'Name of Principal / School Head', 'Contact of Principal / School Head',
  'Principal / School Head Email ID', 'Name of Coordinating Teacher', 'Contact of Coordinating Teacher', 'Kit Handover Date'];
const DIRECT = ['Timestamp', 'Sales Person', 'Name of the School', 'School City', 'School Address Google Map Link', 'School Board',
  'Name of Coordinating Teacher', 'Contact of Coordinating Teacher', 'Official School Email ID  ', 'Date of Kit Handover', 'No of Kit'];
test.before(async () => { await h.resetDb(); });
test.after(async () => { await db.close(); });

const schools = async () => Object.fromEntries((await db.query(`SELECT s.school_name, c.name AS channel, p.name AS partner
  FROM schools s LEFT JOIN channels c USING (channel_id) LEFT JOIN partners p USING (partner_id)`)).rows.map((r) => [r.school_name, r]));

test('fixed Channel and Partner apply to every row of a tab; Direct tab takes Partner from a column', async () => {
  h.writeSheet('partners', 'Shivaji University', [INST, ['29/09/2026 10:15:00', 'Atmiya Vidyalay', 'Vadodara', 'CBSE', 'R Patel', '9800000001', 'head@atmiya.in', 'Rutarth Shah', '9800000002', '29/09/2026']]);
  h.writeSheet('partners', 'SL Team - Direct', [DIRECT, ['30/09/2026 11:00:00', 'Abhishek Mishra', 'Sunrise Public School', 'Pune', 'https://maps.app.goo.gl/x', 'CBSE', 'A Rao', '9800000003', 'office@sunrise.in', '30/09/2026', '2']]);
  const shivaji = await h.addSource({ source_name: 'Shivaji University', spreadsheet_id: 'partners', sheet_name: 'Shivaji University', source_type: 'SCHOOL_MASTER',
    fixed_values: { channel: 'Institutions', partner: 'Shivaji University' } });
  const direct = await h.addSource({ source_name: 'SL Team - Direct', spreadsheet_id: 'partners', sheet_name: 'SL Team - Direct', source_type: 'SCHOOL_MASTER',
    fixed_values: { channel: 'Direct' }, column_mapping: { 'Sales Person': 'partner' } });
  for (const s of [shivaji, direct]) {
    const r = await syncSource(s.source_id, { triggeredBy: 'test' });
    assert.deepEqual(r.unmapped_headers, [], `${s.source_name}: ${r.unmapped_headers}`);
  }
  for (const s of [shivaji, direct]) { const r = await syncSource(s.source_id, { triggeredBy: 'test' }); assert.equal(r.status, 'SUCCESS', r.message); }
  const d = (await db.query(`SELECT * FROM schools WHERE school_name='Sunrise Public School'`)).rows[0];
  assert.deepEqual([d.state, d.district], ['Maharashtra', 'Pune']); // state filled from the city
  assert.deepEqual([d.city, d.coordinator_name, d.coordinator_phone, d.school_email, d.kit_drop_date, d.number_of_kits], ['Pune', 'A Rao', '9800000003', 'office@sunrise.in', '2026-09-30', 2]);
  const a = (await db.query(`SELECT * FROM schools WHERE school_name='Atmiya Vidyalay'`)).rows[0];
  assert.deepEqual([a.state, a.city], ['Gujarat', 'Vadodara']); // from the address after the sync
  assert.deepEqual([a.principal_name, a.principal_contact, a.coordinator_name, a.kit_drop_date, a.number_of_kits], ['R Patel', '9800000001', 'Rutarth Shah', '2026-09-29', 1]);
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
