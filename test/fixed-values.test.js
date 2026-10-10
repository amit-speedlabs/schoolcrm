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
  h.writeSheet('partners', 'SL Team - Direct', [DIRECT, ['30/09/2026 11:00:00', 'Abhishek Mishra', 'Sunrise Public School', 'Pune', 'https://maps.app.goo.gl/x', 'CBSE', 'A Rao', '9800000003', 'office@sunrise.in', '30/09/2026', '2'],
    // kit handed over but the handover date left blank: counts as given on the form date
    ['01/10/2026 12:00:00', 'Kuldeep Patel', 'GROW School', 'Surat', '', 'CBSE', 'B Shah', '9800000004', '', '', '1']]);
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
  assert.deepEqual([d.city, d.coordinator_name, d.coordinator_phone, d.school_email, d.kit_drop_date, d.number_of_kits], ['Pune', 'A Rao', '9800000003', 'office@sunrise.in', '2026-09-30', 1]);
  const a = (await db.query(`SELECT * FROM schools WHERE school_name='Atmiya Vidyalay'`)).rows[0];
  assert.deepEqual([a.state, a.city], ['Gujarat', 'Vadodara']); // from the address after the sync
  assert.deepEqual([a.principal_name, a.principal_contact, a.coordinator_name, a.kit_drop_date, a.number_of_kits], ['R Patel', '9800000001', 'Rutarth Shah', '2026-09-29', 1]);
  const grow = (await db.query(`SELECT kit_given, kit_drop_date, state FROM schools WHERE school_name='GROW School'`)).rows[0];
  assert.deepEqual([grow.kit_given, grow.kit_drop_date, grow.state], [true, '2026-10-01', 'Gujarat']);
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

test('a tab written in US date order (9/29/2026) is read month-first, including ambiguous dates', async () => {
  h.writeSheet('us', 'SL Team - Direct', [DIRECT,
    ['9/29/2026 10:00:00', 'Krutarth Shah', 'Zenith School', 'Vadodara', '', 'GSEB', 'Mari', '7226071801', '', '9/29/2026', '1'],
    ['10/1/2026 10:00:00', 'Kuldeep Patel', 'BPM Public School', 'Tatithaiya', '', 'CBSE', 'Jani', '9824031987', '', '10/1/2026', '1']]);
  const s = await h.addSource({ source_name: 'US dates', spreadsheet_id: 'us', sheet_name: 'SL Team - Direct', source_type: 'SCHOOL_MASTER', date_format: 'DMY',
    fixed_values: { channel: 'Direct' }, column_mapping: { 'Sales Person': 'partner' } });
  const r = await syncSource(s.source_id, { triggeredBy: 'test' });
  assert.equal(r.status, 'SUCCESS', r.message);
  const k = Object.fromEntries((await db.query(`SELECT school_name, kit_given, kit_drop_date, state FROM schools WHERE school_name IN ('Zenith School','BPM Public School')`)).rows.map((x) => [x.school_name, x]));
  assert.deepEqual([k['Zenith School'].kit_given, k['Zenith School'].kit_drop_date, k['Zenith School'].state], [true, '2026-09-29', 'Gujarat']);
  assert.deepEqual([k['BPM Public School'].kit_drop_date, k['BPM Public School'].state], ['2026-10-01', 'Gujarat']);
});

test('a kit sheet counts exactly 1 kit for every school listed, even with no date or a bigger count', async () => {
  h.writeSheet('kit1', 'Tab', [['Name of the School', 'School City', 'Date of Kit Handover', 'No of Kit', 'Timestamp'],
    ['Many Kits School', 'Surat', '02/10/2026', '3', ''],
    ['No Date School', 'Surat', '', '', '03/10/2026 10:00:00'],
    ['Bare School', 'Surat', '', '', '']]);
  const s = await h.addSource({ source_name: 'One kit', spreadsheet_id: 'kit1', sheet_name: 'Tab', source_type: 'SCHOOL_MASTER' });
  assert.equal((await syncSource(s.source_id, { triggeredBy: 'test' })).status, 'SUCCESS');
  const k = Object.fromEntries((await db.query(`SELECT school_name, kit_given, kit_drop_date, number_of_kits FROM schools WHERE school_name IN ('Many Kits School','No Date School','Bare School')`)).rows.map((x) => [x.school_name, [x.kit_given, x.number_of_kits]]));
  assert.deepEqual(k, { 'Many Kits School': [true, 1], 'No Date School': [true, 1], 'Bare School': [true, 1] });
  const nd = (await db.query(`SELECT kit_drop_date FROM schools WHERE school_name='No Date School'`)).rows[0];
  assert.equal(nd.kit_drop_date, '2026-10-03'); // the form Timestamp stands in for a missing kit date
  // the rule can be switched off per source
  await db.query('UPDATE data_sources SET one_kit_per_school=FALSE WHERE source_id=$1', [s.source_id]);
  await syncSource(s.source_id, { triggeredBy: 'test' });
  assert.equal((await db.query(`SELECT number_of_kits FROM schools WHERE school_name='Many Kits School'`)).rows[0].number_of_kits, 3);
});

test('a chain school in another state is a new school, not a possible duplicate (tab without a City column)', async () => {
  h.writeSheet('chain', 'Patan', [['Name of the School', 'School City', 'Kit Handover Date'], ['Sri Chaitanya Techno School', 'Patan', '01/10/2026']]);
  h.writeSheet('chain', 'AEM', [INST, ['10/7/2026 14:56:56', 'Sri Chaitanya Techno School', 'Karruppayurani, Madurai, Tamil Nadu 625020', 'CBSE', 'Ms.Shalini Ramakrishnan', '9384614162', 'maduraiprincipal@srichaitanyaschool.net', '', '', '10/7/2026']]);
  const patan = await h.addSource({ source_name: 'Patan', spreadsheet_id: 'chain', sheet_name: 'Patan', source_type: 'SCHOOL_MASTER' });
  const aem = await h.addSource({ source_name: 'AEM', spreadsheet_id: 'chain', sheet_name: 'AEM', source_type: 'SCHOOL_MASTER', date_format: 'MDY' });
  await syncSource(patan.source_id, { triggeredBy: 'test' });
  const r = await syncSource(aem.source_id, { triggeredBy: 'test' });
  assert.equal(r.rows_created, 1, r.message);
  const rows = (await db.query(`SELECT state FROM schools WHERE school_name='Sri Chaitanya Techno School' ORDER BY school_id`)).rows.map((x) => x.state);
  assert.deepEqual(rows, ['Gujarat', 'Tamil Nadu']);
});

test('a tab marked as a kit tab gives every school 1 kit even without a kit column (SL Team - AEM)', async () => {
  h.writeSheet('aem', 'SL Team - AEM', [['Timestamp', 'AEM', 'Name of the School', 'School Address', 'School Board'],
    ['10/7/2026 11:57:27', 'Kumar upadheya', 'Bishop Cotton High School', 'Chindwada Road, Nagpur 440013', 'SSC']]);
  const s = await h.addSource({ source_name: 'SL Team - AEM', spreadsheet_id: 'aem', sheet_name: 'SL Team - AEM', source_type: 'SCHOOL_MASTER', date_format: 'MDY',
    fixed_values: { channel: 'Direct AEM' }, column_mapping: { AEM: 'partner' } });
  const q = `SELECT kit_given, kit_drop_date, number_of_kits FROM schools WHERE school_name='Bishop Cotton High School'`;
  await syncSource(s.source_id, { triggeredBy: 'test' });
  assert.equal((await db.query(q)).rows[0].kit_given, false); // Auto: no kit column, so not a kit tab
  await db.query('UPDATE data_sources SET one_kit_per_school=TRUE WHERE source_id=$1', [s.source_id]);
  await syncSource(s.source_id, { triggeredBy: 'test' });
  const k = (await db.query(q)).rows[0];
  assert.deepEqual([k.kit_given, k.kit_drop_date, k.number_of_kits], [true, '2026-10-07', 1]);
});
