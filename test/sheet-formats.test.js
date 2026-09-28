'use strict';
// Real-world sheet shapes: a courier tracker mixing schools and consultants
// (row filter, "Name"/"Contact Number"/"Dispatch Date" headers, dates without a year)
// and a registration sheet that gives only a total student count.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { db } = h;
const { syncAll, syncSource } = require('../src/sync/syncEngine');

const COURIER = [
  ['Name', 'Type', 'City', 'Address', 'Pin Code', 'State', 'School Coordinator Name', 'Contact Number', 'Tracking ID', 'Dispatch Date', 'Expected Delivery Date'],
  ['Dr. Bachcha Prasad Memorial School', 'School', 'Siwan', 'Society Complex, Majhauli Road', '841239', 'Bihar', 'Kundan Kumar', '', 'DTDC', '28 Sep', ''],
  ['SWETAMBARA PUBLIC SCHOOL', 'School', 'Patna', 'Bariyarpur, NTPC Barh', '803213', 'Bihar', 'Kumar Shivam', '8434779287', 'DTDC', '28 Sep', ''],
  ['Roboneve', 'Consultant', 'Mumbai', 'Shantinath Park', '401303', 'Maharashtra', 'Swapnil', '7757909352', 'DTDC', '28 Sep', ''],
  ['B A Damahe(Consultant)', 'Consultant', 'Mumbai', 'L&T STA', '400061', 'Maharashtra', 'B A Damahe', '9833078355', 'Rapido', '28 Sep', ''],
];
const REG = [
  ['School Name', 'City', 'Address', 'Pin Code', 'State', 'Board', 'School Email ID', 'School Coordinator Name', 'School Coordinator Phone', 'Total Registration'],
  ['Meena Bhujbal School of Excellence', 'Nashik', 'Bhujbal Knowledge City Adgaon', '422003', 'Maharashtra', 'CBSE', 'harshitaj_mbse@bkc.met.edu', 'Ms.Harshita Jaiswal', '7498897059', '51'],
  ['Swetambara Public School', 'Patna', 'Bariyarpur, NTPC Barh', '803213', 'Bihar', 'CBSE', '', 'Kumar Shivam', '8434779287', '120'],
];
const YEAR = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(new Date());

let S;
test.before(async () => {
  await h.resetDb();
  h.writeSheet('courier', 'School Sales Kit', COURIER);
  h.writeSheet('b2b', 'Overall', REG);
  S = {
    courier: await h.addSource({ source_name: 'Courier Tracker', spreadsheet_id: 'courier', sheet_name: 'School Sales Kit', source_type: 'SCHOOL_MASTER', writeback_enabled: true, row_filter: { Type: 'School' } }),
    regMaster: await h.addSource({ source_name: 'B2B Registration (schools)', spreadsheet_id: 'b2b', sheet_name: 'Overall', source_type: 'SCHOOL_MASTER', writeback_enabled: true }),
    reg: await h.addSource({ source_name: 'B2B Registration', spreadsheet_id: 'b2b', sheet_name: 'Overall', source_type: 'COMBINED_REGISTRATION' }),
  };
});
test.after(async () => { await db.close(); });

test('courier tracker: only Type = School rows become schools, with kit date from a year-less Dispatch Date', async () => {
  const r = await syncSource(S.courier.source_id, { triggeredBy: 'test' });
  assert.equal(r.status, 'SUCCESS', r.message);
  assert.equal(r.rows_created, 2);
  assert.match(r.message, /2 rows skipped by the row filter/);
  const { rows } = await db.query('SELECT school_name, kit_given, kit_drop_date, coordinator_phone FROM schools ORDER BY school_id');
  assert.deepEqual(rows.map((x) => x.school_name), ['Dr. Bachcha Prasad Memorial School', 'SWETAMBARA PUBLIC SCHOOL']);
  assert.ok(rows.every((x) => x.kit_given && x.kit_drop_date === `${YEAR}-09-28`));
  assert.equal(rows[1].coordinator_phone, '8434779287');
  const sheet = h.readSheet('courier', 'School Sales Kit');
  assert.equal(sheet[0][11], 'School ID');
  assert.deepEqual(sheet.slice(1).map((row) => row[11] || ''), ['SCH000001', 'SCH000002', '', '']);
});

test('registration sheet: new schools created, existing matched, registered with total-only student counts', async () => {
  const results = await syncAll({ triggeredBy: 'test' });
  for (const x of results) assert.notEqual(x.status, 'FAILED', x.message);
  const { rows } = await db.query(`SELECT s.school_id, s.school_name, s.school_registered, s.kit_given, t.ungraded, t.total_students
    FROM schools s LEFT JOIN school_student_totals t USING (school_id) ORDER BY s.school_id`);
  assert.equal(rows.length, 3, JSON.stringify(rows));
  const byName = Object.fromEntries(rows.map((x) => [x.school_name.toLowerCase(), x]));
  const meena = byName['meena bhujbal school of excellence'];
  assert.ok(meena.school_registered);
  assert.equal(meena.kit_given, false);
  assert.equal(meena.total_students, 51);
  assert.equal(meena.ungraded, 51);
  const swet = byName['swetambara public school'];
  assert.equal(swet.school_id, 'SCH000002');
  assert.ok(swet.school_registered && swet.kit_given);
  assert.equal(swet.total_students, 120);
  assert.equal(byName['dr. bachcha prasad memorial school'].school_registered, false);

  const again = await syncAll({ triggeredBy: 'test' });
  for (const x of again) assert.equal(x.rows_created, 0);
  const { rows: [{ count }] } = await db.query('SELECT count(*)::int FROM student_registrations WHERE NOT is_superseded');
  assert.equal(count, 2);
});

test('changing a source type re-applies rows that did not change in the sheet', async () => {
  // a registration source first saved as School Registration, then edited to School + Student Registration
  await db.query(`DELETE FROM student_registrations`);
  await db.query(`UPDATE data_sources SET source_type='SCHOOL_REGISTRATION' WHERE source_id=$1`, [S.reg.source_id]);
  await syncSource(S.reg.source_id, { triggeredBy: 'test' });
  await db.query(`UPDATE data_sources SET source_type='COMBINED_REGISTRATION' WHERE source_id=$1`, [S.reg.source_id]);
  const r = await syncSource(S.reg.source_id, { triggeredBy: 'test' });
  assert.equal(r.rows_unchanged, 0, r.message);
  const { rows: [{ students }] } = await db.query('SELECT coalesce(sum(total_students),0)::int AS students FROM school_student_totals');
  assert.equal(students, 171);
});

test('a row filter naming a missing column fails the sync with a clear message', async () => {
  await db.query(`UPDATE data_sources SET row_filter='{"Category":"School"}' WHERE source_id=$1`, [S.courier.source_id]);
  const r = await syncSource(S.courier.source_id, { triggeredBy: 'test' });
  assert.equal(r.status, 'FAILED');
  assert.match(r.message, /Row filter column "Category" not found/);
  await db.query(`UPDATE data_sources SET row_filter='{"Type":"School"}' WHERE source_id=$1`, [S.courier.source_id]);
});
