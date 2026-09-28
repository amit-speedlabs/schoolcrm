'use strict';
// End-to-end tests covering the post-implementation checklist in the spec (§40).
// Runs against a real PostgreSQL database (TEST_DATABASE_URL) and CSV-backed fake sheets.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const h = require('./helpers');
const { db } = h;
const { syncSource, syncAll, isDue } = require('../src/sync/syncEngine');
const { parseCsv } = require('../src/sheets/fixtureAdapter');

const MASTER_H = ['School Name', 'City', 'Address', 'Pin Code', 'State', 'Board', 'School Principal Name', 'School Principal Contact',
  'School Email', 'School Coordinator Name', 'School Coordinator Phone', 'School Kit Drop Date', 'No of Kits', 'Channel', 'Sales SPOC'];
const MASTER = [
  MASTER_H,
  ['ABC School', 'Pune', '1 FC Road', '411001', 'Maharashtra', 'CBSE', 'Asha Rao', '9800000001', 'abc@school.in', 'Ravi K', '9800000101', '20/09/2026', '2', 'CoE', 'Amit'],
  ['XYZ Public School', 'Mumbai', '2 Marine Drive', '400001', 'Maharashtra', 'ICSE', 'Bina Shah', '9800000002', 'xyz@school.in', 'Sam T', '9800000102', '', '', 'Direct', 'Priya'],
  ['Surat Vidya Mandir', 'Surat', '3 Ring Road', '395007', 'Gujarat', 'GSEB', 'Chetan Patel', '9800000003', 'svm@school.in', 'Hema P', '9800000103', '05/09/2026', '1', 'Gujarat Sales Team', 'Priya'],
  ['Lucknow Academy', 'Lucknow', '4 Hazratganj', '226010', 'Uttar Pradesh', 'CBSE', 'Dinesh Verma', '9800000004', 'la@school.in', 'Isha V', '9800000104', '10/09/2026', '3', 'AEMs', 'Rahul'],
  ['Bad Data School', 'Pune', '5 Camp', '12AB', 'Maharashtra', 'CBSE', 'Eva', '123', 'not-an-email', 'Jai', '', '31/02/2026', '-1', 'CoE', 'Amit'],
  ['', 'Pune', 'no name', '411002', 'Maharashtra', 'CBSE', '', '', '', '', '', '', '', '', ''],
  ['A.B.C. School', 'Pune', '1 FC Road', '411001', 'Maharashtra', 'CBSE', 'Asha Rao', '9800000001', '', '', '', '', '', 'CoE', 'Amit'],
];
const REG = [
  ['Timestamp', 'School', 'City', 'School Email ID', 'Registered?'],
  ['21/09/2026 10:00:00', 'ABC School', 'Pune', 'abc@school.in', 'Yes'],
  ['12/09/2026 09:00:00', 'Lucknow Academy', 'Lucknow', '', 'Yes'],
  ['14/09/2026 09:00:00', 'Surat Vidhya Mandir School', 'Surat', '', 'Yes'],
  ['15/09/2026 09:00:00', 'Unknown School', 'Nagpur', 'unknown@school.in', 'Yes'],
];
const G = ['Grade 3', 'Grade 4', 'Grade 5', 'Grade 6', 'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10'];
const STU = [
  ['Timestamp', 'School ID', 'School Name', ...G, 'Total Students'],
  ['22/09/2026 10:00:00', 'SCH000001', 'ABC School', '10', '10', '10', '10', '10', '10', '10', '10', '80'],
  ['12/09/2026 10:00:00', 'SCH000004', 'Lucknow Academy', '5', '5', '5', '5', '0', '0', '0', '0', '20'],
  ['15/09/2026 10:00:00', 'SCH000004', 'Lucknow Academy', '6', '5', '5', '5', '0', '0', '0', '0', '999'],
  ['16/09/2026 10:00:00', 'SCH999999', 'Ghost School', '1', '1', '1', '1', '1', '1', '1', '1', '8'],
  ['17/09/2026 10:00:00', 'SCH000002', 'XYZ Public School', '-3', '1', '1', '1', '1', '1', '1', '1', ''],
];

let srv; let admin; let mgmt; let anon; let S = {};
const metrics = async (qs = '') => (await admin.get(`/api/dashboard/metrics?${qs}`)).body;
const count = async (sql, p) => (await db.query(sql, p)).rows[0].n;

test.before(async () => {
  await h.resetDb();
  await h.createLogin('admin@test.in', 'AdminPass123', 'ADMIN');
  await h.createLogin('mgmt@test.in', 'MgmtPass123', 'MANAGEMENT');
  h.writeSheet('crm', 'School Master', MASTER);
  h.writeSheet('crm', 'School Registration', REG);
  h.writeSheet('crm', 'Student Registration', STU);
  S.master = await h.addSource({ source_name: 'School Master', spreadsheet_id: 'crm', sheet_name: 'School Master', source_type: 'SCHOOL_MASTER', writeback_enabled: true });
  S.reg = await h.addSource({ source_name: 'School Registration', spreadsheet_id: 'crm', sheet_name: 'School Registration', source_type: 'SCHOOL_REGISTRATION', form_url: 'https://forms.gle/HQZmrarJdDNBpGgm6' });
  S.stu = await h.addSource({ source_name: 'Student Registration', spreadsheet_id: 'crm', sheet_name: 'Student Registration', source_type: 'STUDENT_REGISTRATION' });
  srv = await h.startServer();
  admin = h.client(srv.base); mgmt = h.client(srv.base); anon = h.client(srv.base);
});
test.after(async () => { srv.server.close(); await db.close(); });

test('1. application runs: health check, authentication and roles', async () => {
  assert.equal((await anon.get('/healthz')).body.ok, true);
  assert.equal((await anon.get('/api/schools')).status, 401);
  assert.equal((await anon.login('admin@test.in', 'wrong')).status, 401);
  assert.equal((await admin.login('admin@test.in', 'AdminPass123')).status, 200);
  assert.equal((await mgmt.login('mgmt@test.in', 'MgmtPass123')).status, 200);
  assert.equal((await admin.get('/api/auth/me')).body.user.access_role, 'ADMIN');
  const html = await anon.get('/');
  assert.match(html.body, /GLF AI OLYMPIAD 2026/);
});

test('2. database operations: migrations applied, constraints enforced', async () => {
  const { rows } = await db.query('SELECT name FROM schema_migrations ORDER BY 1');
  assert.deepEqual(rows.map((r) => r.name), ['001_init.sql', '002_seed_reference.sql', '003_total_only_and_row_filter.sql']);
  for (const t of ['users', 'schools', 'school_contacts', 'channels', 'partners', 'student_registrations', 'data_sources', 'sync_logs', 'audit_logs', 'follow_ups']) {
    assert.equal(await count(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name=$1`, [t]), 1, t);
  }
  await assert.rejects(db.query(`INSERT INTO schools (school_name) VALUES ('  ')`), /check/i);
  await assert.rejects(db.query(`INSERT INTO schools (school_id, school_name) VALUES ('ABC1','x')`), /check/i);
  // (a failed INSERT consumes a sequence value, like any Postgres sequence; reset so the rest of the suite gets SCH000001..)
  await db.query(`ALTER SEQUENCE school_id_seq RESTART WITH 1`);
});

test('3+4+5. School Master sync: mapping, School ID generation, validation, write-back', async () => {
  const r = await syncSource(S.master.source_id, { triggeredBy: 'test' });
  assert.equal(r.status, 'PARTIAL'); // one row rejected (blank name)
  assert.equal(r.rows_read, 7);
  assert.equal(r.rows_created, 5);
  assert.equal(r.rows_errored, 1);
  assert.equal(r.rows_flagged, 1);   // "A.B.C. School" duplicate row inside the master
  assert.deepEqual(r.unmapped_headers, []);

  const { rows } = await db.query('SELECT * FROM schools ORDER BY school_id');
  assert.deepEqual(rows.map((s) => s.school_id), ['SCH000001', 'SCH000002', 'SCH000003', 'SCH000004', 'SCH000005']);
  const abc = rows[0];
  // every School Master field is displayed after sync (success criteria step 4)
  assert.equal(abc.school_name, 'ABC School'); assert.equal(abc.city, 'Pune'); assert.equal(abc.district, 'Pune');
  assert.equal(abc.state, 'Maharashtra'); assert.equal(abc.address, '1 FC Road'); assert.equal(abc.pin_code, '411001');
  assert.equal(abc.board, 'CBSE'); assert.equal(abc.principal_name, 'Asha Rao'); assert.equal(abc.principal_contact, '9800000001');
  assert.equal(abc.school_email, 'abc@school.in'); assert.equal(abc.coordinator_name, 'Ravi K'); assert.equal(abc.coordinator_phone, '9800000101');
  assert.equal(abc.kit_drop_date, '2026-09-20'); assert.equal(abc.number_of_kits, 2);
  assert.equal(abc.source_sheet, 'School Master'); assert.equal(abc.source_row, 2); assert.ok(abc.last_synced_at);
  const prof = (await admin.get('/api/schools/SCH000001')).body;
  assert.equal(prof.channel, 'CoE'); assert.equal(prof.sales_spoc, 'Amit');
  assert.equal(prof.contacts.length, 2);

  // District derived from City (sheet has no District column)
  assert.equal(rows[1].district, 'Mumbai City');
  // invalid values become warnings, never bad data
  const bad = rows[4];
  assert.equal(bad.pin_code, null); assert.equal(bad.principal_contact, null); assert.equal(bad.school_email, null);
  assert.equal(bad.kit_drop_date, null); assert.equal(bad.number_of_kits, null);
  const issues = (await db.query('SELECT field, severity, message FROM sync_row_issues WHERE sync_id=$1', [r.sync_id])).rows;
  for (const f of ['pin_code', 'principal_contact', 'school_email', 'kit_drop_date', 'number_of_kits']) assert.ok(issues.some((i) => i.field === f && i.severity === 'WARNING'), f);
  assert.ok(issues.some((i) => i.severity === 'ERROR' && /School Name/i.test(i.message)));

  // Channel + SPOC masters populated from sheet values (not hard-coded)
  assert.equal(await count(`SELECT count(*)::int AS n FROM channels`), 4);
  assert.equal(await count(`SELECT count(*)::int AS n FROM users WHERE access_role='NONE'`), 3);

  // write-back: School ID + District appended as new columns, existing columns untouched
  const sheet = h.readSheet('crm', 'School Master');
  assert.deepEqual(sheet[0].slice(0, 15), MASTER_H);
  assert.equal(sheet[0][15], 'School ID'); assert.equal(sheet[0][16], 'District');
  assert.deepEqual(sheet.slice(1, 6).map((x) => x[15]), ['SCH000001', 'SCH000002', 'SCH000003', 'SCH000004', 'SCH000005']);
  assert.equal(sheet[6][15] || '', ''); // rejected row gets no ID
  assert.equal(sheet[7][15] || '', ''); // row under review gets no ID
  assert.equal(sheet[2][16], 'Mumbai City');
});

test('4b. School IDs are stable: re-sync, re-ordered rows and manual edits never change them', async () => {
  const again = await syncSource(S.master.source_id, { triggeredBy: 'test' });
  assert.equal(again.rows_created, 0);
  assert.equal(again.rows_updated, 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM schools'), 5);
  // reorder the sheet (move XYZ to the bottom): ID column keeps the link
  const sheet = h.readSheet('crm', 'School Master');
  const xyz = sheet.splice(2, 1)[0];
  sheet.push(xyz);
  h.writeSheet('crm', 'School Master', sheet);
  const r = await syncSource(S.master.source_id, { triggeredBy: 'test' });
  assert.equal(r.rows_created, 0);
  const x = (await db.query(`SELECT * FROM schools WHERE school_id='SCH000002'`)).rows[0];
  assert.equal(x.school_name, 'XYZ Public School');
  assert.equal(x.source_row, 8);
  const res = await admin.patch('/api/schools/SCH000002', { school_id: 'SCH999999', district: 'Mumbai Suburban' });
  assert.equal(res.status, 200);
  assert.equal(res.body.school_id, 'SCH000002');
  assert.equal(res.body.district, 'Mumbai Suburban');
});

test('6. kit status is calculated from Kit Drop Date', async () => {
  const k = Object.fromEntries((await db.query('SELECT school_id, kit_given FROM schools')).rows.map((r) => [r.school_id, r.kit_given]));
  assert.deepEqual(k, { SCH000001: true, SCH000002: false, SCH000003: true, SCH000004: true, SCH000005: false });
  // clearing the date in the sheet flips Kit Given to NO, and the change is audited
  const sheet = h.readSheet('crm', 'School Master');
  const row = sheet.find((x) => x[15] === 'SCH000003');
  row[11] = ''; row[12] = '';
  h.writeSheet('crm', 'School Master', sheet);
  await syncSource(S.master.source_id, { triggeredBy: 'test' });
  assert.equal((await db.query(`SELECT kit_given FROM schools WHERE school_id='SCH000003'`)).rows[0].kit_given, false);
  const a = (await db.query(`SELECT * FROM audit_logs WHERE entity_id='SCH000003' AND field='kit_drop_date'`)).rows[0];
  assert.equal(a.old_value, '2026-09-05'); assert.equal(a.new_value, null); assert.equal(a.change_source, 'SYNC');
  row[11] = '05/09/2026'; row[12] = '1';
  h.writeSheet('crm', 'School Master', sheet);
  await syncSource(S.master.source_id, { triggeredBy: 'test' });
  assert.equal((await db.query(`SELECT kit_given FROM schools WHERE school_id='SCH000003'`)).rows[0].kit_given, true);
});

test('7. school registration from another sheet links to the same School ID', async () => {
  const r = await syncSource(S.reg.source_id, { triggeredBy: 'test' });
  assert.equal(r.status, 'SUCCESS');
  assert.equal(r.rows_updated, 2);
  assert.equal(r.rows_flagged, 2); // spelling variant (possible duplicate) + unknown school
  const s = Object.fromEntries((await db.query('SELECT school_id, school_registered, registration_date, registration_form FROM schools')).rows.map((x) => [x.school_id, x]));
  assert.equal(s.SCH000001.school_registered, true);
  assert.equal(s.SCH000001.registration_date, '2026-09-21');
  assert.equal(s.SCH000001.registration_form, 'https://forms.gle/HQZmrarJdDNBpGgm6');
  assert.equal(s.SCH000004.school_registered, true);
  assert.equal(s.SCH000003.school_registered, false); // waits for admin review, no auto-link
  assert.equal(await count('SELECT count(*)::int AS n FROM schools'), 5); // nothing auto-created
});

test('8+9. grade-wise student registration and total calculation', async () => {
  const r = await syncSource(S.stu.source_id, { triggeredBy: 'test' });
  assert.equal(r.rows_errored, 2); // unknown School ID + negative count
  const t = Object.fromEntries((await db.query('SELECT * FROM school_student_totals')).rows.map((x) => [x.school_id, x]));
  assert.equal(t.SCH000001.total_students, 80);
  assert.equal(t.SCH000001.grade_3, 10);
  // LATEST mode: the newer response for SCH000004 replaces the older one; total is calculated (sheet said 999)
  assert.equal(t.SCH000004.total_students, 21);
  assert.equal(t.SCH000004.grade_3, 6);
  assert.equal(t.SCH000002, undefined);
  const issues = (await db.query('SELECT * FROM sync_row_issues WHERE sync_id=$1', [r.sync_id])).rows;
  assert.ok(issues.some((i) => /differs from grade-wise sum 21/.test(i.message)));
  assert.ok(issues.some((i) => /SCH999999 does not exist/.test(i.message)));
  assert.ok(issues.some((i) => /cannot be negative/.test(i.message)));
  // SUM mode adds responses instead
  await db.query(`UPDATE data_sources SET student_mode='SUM' WHERE source_id=$1`, [S.stu.source_id]);
  await db.query(`UPDATE source_rows SET row_hash='' WHERE source_id=$1`, [S.stu.source_id]);
  await syncSource(S.stu.source_id, { triggeredBy: 'test' });
  assert.equal((await db.query(`SELECT total_students FROM school_student_totals WHERE school_id='SCH000004'`)).rows[0].total_students, 41);
  await db.query(`UPDATE data_sources SET student_mode='LATEST' WHERE source_id=$1`, [S.stu.source_id]);
  await db.query(`UPDATE source_rows SET row_hash='' WHERE source_id=$1`, [S.stu.source_id]);
  await syncSource(S.stu.source_id, { triggeredBy: 'test' });
  assert.equal((await db.query(`SELECT total_students FROM school_student_totals WHERE school_id='SCH000004'`)).rows[0].total_students, 21);
  // manual student registration: validation + auto total
  assert.equal((await admin.post('/api/schools/SCH000002/student-registrations', { grade_3_count: -1 })).status, 400);
  assert.equal((await admin.post('/api/schools/SCH000002/student-registrations', { grade_3_count: 'abc' })).status, 400);
  const ok = await admin.post('/api/schools/SCH000002/student-registrations', { grade_5_count: 4, grade_6_count: 3, registration_date: '2026-09-23' });
  assert.equal(ok.status, 201); assert.equal(ok.body.total_students, 7);
});

test('10. dashboard calculations', async () => {
  const m = await metrics();
  assert.equal(m.schools, 5);
  assert.equal(m.kits_distributed, 3);       // SCH1, SCH3, SCH4
  assert.equal(m.total_kits, 6);
  assert.equal(m.registered_schools, 2);     // SCH1, SCH4
  assert.equal(m.students, 108);             // 80 + 21 + 7
  assert.equal(m.kit_coverage_pct, 60);
  assert.equal(m.registration_pct, 40);
  assert.equal(m.kit_to_registration_pct, 66.7);
  assert.equal(m.avg_students_per_registered_school, 54);
  assert.equal(m.grade_3, 16);
  assert.equal([3, 4, 5, 6, 7, 8, 9, 10].reduce((a, g) => a + m[`grade_${g}`], 0), m.students);
  // a registered school can have zero students; a non-registered school can have students (reported factually)
  assert.equal(m.schools_with_students, 3);
});

test('14. duplicate detection and admin review (no duplicate schools)', async () => {
  const reviews = (await admin.get('/api/reviews')).body;
  assert.equal(reviews.length, 3);
  const inSheet = reviews.find((r) => r.incoming.school_name === 'A.B.C. School');
  assert.equal(inSheet.kind, 'POSSIBLE_DUPLICATE');
  assert.equal(inSheet.candidates[0].school_id, 'SCH000001');
  assert.ok(inSheet.candidates[0].reasons.includes('Same principal contact'));
  const variant = reviews.find((r) => r.incoming.school_name === 'Surat Vidhya Mandir School');
  assert.equal(variant.kind, 'POSSIBLE_DUPLICATE');
  assert.equal(variant.candidates[0].school_id, 'SCH000003');
  const unknown = reviews.find((r) => r.incoming.school_name === 'Unknown School');
  assert.equal(unknown.kind, 'UNMATCHED');

  // management cannot resolve
  assert.equal((await mgmt.post(`/api/reviews/${variant.review_id}/resolve`, { action: 'link', school_id: 'SCH000003' })).status, 403);
  // admin links the spelling variant -> registration applies to SCH000003
  const l = await admin.post(`/api/reviews/${variant.review_id}/resolve`, { action: 'link', school_id: 'SCH000003' });
  assert.equal(l.status, 200);
  assert.equal((await db.query(`SELECT school_registered FROM schools WHERE school_id='SCH000003'`)).rows[0].school_registered, true);
  // admin creates the unknown school -> new ID, registered
  const c = await admin.post(`/api/reviews/${unknown.review_id}/resolve`, { action: 'create' });
  assert.equal(c.body.review.resolved_school_id, 'SCH000006');
  const u = (await db.query(`SELECT * FROM schools WHERE school_id='SCH000006'`)).rows[0];
  assert.equal(u.school_name, 'Unknown School'); assert.equal(u.school_registered, true); assert.equal(u.school_email, 'unknown@school.in');
  // admin dismisses the in-sheet duplicate row
  assert.equal((await admin.post(`/api/reviews/${inSheet.review_id}/resolve`, { action: 'dismiss' })).status, 200);
  assert.equal((await admin.get('/api/reviews')).body.length, 0);

  // full re-sync is idempotent: no new schools, no new reviews, no duplicate student rows
  const before = await count('SELECT count(*)::int AS n FROM student_registrations');
  const results = await syncAll({ triggeredBy: 'test' });
  assert.ok(results.every((x) => x.rows_created === 0 && x.rows_flagged === 0), JSON.stringify(results));
  assert.equal(await count('SELECT count(*)::int AS n FROM schools'), 6);
  assert.equal(await count('SELECT count(*)::int AS n FROM student_registrations'), before);
  assert.equal((await admin.get('/api/reviews')).body.length, 0);

  // manual create of an obvious duplicate is blocked unless confirmed
  const dup = await admin.post('/api/schools', { school_name: 'ABC School', city: 'Pune', state: 'Maharashtra' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.candidates[0].school_id, 'SCH000001');
});

test('3b. creating a school manually (validation, generated ID, audit)', async () => {
  const bad = await admin.post('/api/schools', { school_name: '', school_email: 'x@', pin_code: '12', principal_contact: '12', kit_drop_date: '2026-13-40', number_of_kits: -2 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.errors.length, 6);
  const ok = await admin.post('/api/schools', { school_name: 'New Horizon School', city: 'Bengaluru', state: 'KA', pin_code: '560001', school_email: 'NH@School.in', principal_contact: '+91 98450 00007', kit_drop_date: '2026-09-25', number_of_kits: 2 });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.school_id, 'SCH000007');
  assert.equal(ok.body.state, 'Karnataka'); assert.equal(ok.body.district, 'Bengaluru Urban');
  assert.equal(ok.body.school_email, 'nh@school.in'); assert.equal(ok.body.principal_contact, '9845000007');
  assert.equal(ok.body.kit_given, true);
  assert.ok(await count(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_id='SCH000007' AND changed_by LIKE 'user:%'`) > 3);
  assert.equal((await mgmt.post('/api/schools', { school_name: 'Nope' })).status, 403);
  assert.equal((await mgmt.patch('/api/schools/SCH000001', { district: 'X' })).status, 403);
  assert.equal((await admin.post('/api/schools', { school_name: 'No header' }, { headers: { 'x-requested-with': '' } })).status, 403);
});

test('11. filters apply to KPIs, tables and each other', async () => {
  // 7 schools now: SCH1 Pune, SCH2 Mumbai, SCH3 Surat, SCH4 Lucknow, SCH5 Pune(bad), SCH6 Nagpur(no state), SCH7 Bengaluru
  assert.equal((await metrics('state=Maharashtra')).schools, 3);
  assert.equal((await metrics('state=__none__')).schools, 1);
  assert.equal((await metrics('state=Maharashtra&kit=yes')).schools, 1);
  const coe = S.coe = (await db.query(`SELECT channel_id FROM channels WHERE name='CoE'`)).rows[0].channel_id;
  assert.equal((await metrics(`channel=${coe}`)).schools, 2);
  assert.equal((await metrics('registered=yes')).registered_schools, 4);
  assert.equal((await metrics('registered=no')).registered_schools, 0);
  assert.equal((await metrics('board=GSEB')).schools, 1);
  assert.equal((await metrics('district=Mumbai%20Suburban')).schools, 1);
  const spoc = (await db.query(`SELECT user_id FROM users WHERE name='Priya'`)).rows[0].user_id;
  assert.equal((await metrics(`spoc=${spoc}`)).schools, 2);
  assert.equal((await metrics('date_from=2026-09-01&date_to=2026-09-06')).schools, 1); // kit date
  assert.equal((await metrics('date_field=registration&date_from=2026-09-20&date_to=2026-09-30')).schools, 1);
  // school list shares the same filter logic + search fields
  const list = await admin.get('/api/schools?state=Maharashtra&sort=school_name&dir=asc');
  assert.equal(list.body.total, 3);
  assert.deepEqual(list.body.rows.map((r) => r.school_name), ['ABC School', 'Bad Data School', 'XYZ Public School']);
  for (const [q, id] of [['SCH000004', 'SCH000004'], ['9800000004', 'SCH000004'], ['98000 00004', 'SCH000004'], ['dinesh', 'SCH000004'], ['ravi k', 'SCH000001'], ['svm@school', 'SCH000003'], ['lucknow', 'SCH000004']]) {
    const r = await admin.get(`/api/schools?q=${encodeURIComponent(q)}`);
    assert.deepEqual(r.body.rows.map((x) => x.school_id), [id], q);
  }
  const page = await admin.get('/api/schools?pageSize=2&page=2&sort=school_id');
  assert.deepEqual(page.body.rows.map((r) => r.school_id), ['SCH000003', 'SCH000004']);
  assert.equal(page.body.total, 7);
});

test('12. drill-down: state -> district -> city -> school', async () => {
  const states = (await admin.get('/api/dashboard/breakdown/state?sort=schools&dir=desc')).body;
  const mh = states.find((r) => r.label === 'Maharashtra');
  assert.deepEqual([mh.schools, mh.kits_distributed, mh.registered_schools, mh.students], [3, 1, 1, 87]);
  const districts = (await admin.get('/api/dashboard/breakdown/district?state=Maharashtra')).body;
  assert.deepEqual(districts.map((d) => [d.label, d.schools]).sort(), [['Mumbai Suburban', 1], ['Pune', 2]]);
  const cities = (await admin.get('/api/dashboard/breakdown/city?state=Maharashtra&district=Pune')).body;
  assert.deepEqual(cities.map((c) => [c.label, c.schools]), [['Pune', 2]]);
  const schools = (await admin.get('/api/schools?state=Maharashtra&district=Pune&city=Pune')).body;
  assert.deepEqual(schools.rows.map((s) => s.school_id).sort(), ['SCH000001', 'SCH000005']);
  // sorting by each metric
  const byStudents = (await admin.get('/api/dashboard/breakdown/city?sort=students&dir=desc')).body;
  assert.equal(byStudents[0].label, 'Pune');
  const byName = (await admin.get('/api/dashboard/breakdown/state?sort=label&dir=asc')).body;
  assert.equal(byName[0].label, 'Gujarat');
});

test('13. channel dashboard: channel -> partner -> school', async () => {
  // add a Kit Distribution sheet that carries Partner (different header names)
  h.writeSheet('crm', 'Kit Distribution', [
    ['Institution Name', 'City', 'Channel', 'Partner', 'Kit Date', 'Kits Given'],
    ['ABC School', 'Pune', 'CoE', 'Shivaji University', '20-Sep-2026', '2'],
    ['Lucknow Academy', 'Lucknow', 'AEMs', 'XYZ', '', ''],
  ]);
  const src = await h.addSource({ source_name: 'Kit Distribution', spreadsheet_id: 'crm', sheet_name: 'Kit Distribution', source_type: 'KIT_DISTRIBUTION' });
  const r = await syncSource(src.source_id, { triggeredBy: 'test' });
  assert.equal(r.status, 'SUCCESS');
  const ch = (await admin.get('/api/dashboard/breakdown/channel')).body;
  const coe = ch.find((c) => c.label === 'CoE');
  assert.deepEqual([coe.schools, coe.kits_distributed, coe.total_kits, coe.registered_schools, coe.students], [2, 1, 2, 1, 80]);
  const partners = (await admin.get(`/api/dashboard/breakdown/partner?channel=${S.coe}`)).body;
  assert.deepEqual(partners.map((p) => [p.label, p.schools]).sort(), [['Not set', 1], ['Shivaji University', 1]]);
  const shivaji = partners.find((p) => p.label === 'Shivaji University');
  const schools = (await admin.get(`/api/schools?channel=${S.coe}&partner=${shivaji.key}`)).body.rows;
  assert.deepEqual(schools.map((s) => [s.school_id, s.partner, s.school_registered, s.total_students]), [['SCH000001', 'Shivaji University', true, 80]]);
  // Kit sheet with blank date does not wipe the master's kit date
  assert.equal((await db.query(`SELECT kit_drop_date FROM schools WHERE school_id='SCH000004'`)).rows[0].kit_drop_date, '2026-09-10');
  // Channel master admin: add / edit / deactivate
  const add = await admin.post('/api/channels', { name: 'School Fairs', aliases: ['Fair'] });
  assert.equal(add.status, 201);
  assert.equal((await admin.post('/api/channels', { name: 'coe' })).status, 409);
  const off = await admin.patch(`/api/channels/${add.body.channel_id}`, { is_active: false, name: 'School Fair Stalls' });
  assert.equal(off.body.is_active, false); assert.equal(off.body.name, 'School Fair Stalls');
  assert.equal((await mgmt.post('/api/channels', { name: 'X' })).status, 403);
});

test('15. exports (CSV + Excel) respect filters', async () => {
  const csv = await mgmt.get('/api/schools/export?format=csv&state=Maharashtra&sort=school_id');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /\.csv"/);
  const rows = parseCsv(csv.body.replace(/^﻿/, '')).filter((r) => r.length > 1);
  assert.equal(rows.length, 4); // header + 3
  assert.equal(rows[0][0], 'School ID');
  assert.deepEqual(rows.slice(1).map((r) => r[0]), ['SCH000001', 'SCH000002', 'SCH000005']);
  assert.ok(rows[0].includes('Grade 10') && rows[0].includes('Total Students') && rows[0].includes('Kit Given'));
  const res = await admin.get(`/api/schools/export?format=xlsx&channel=${S.coe}&registered=yes`, { raw: true });
  assert.equal(res.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const ws = wb.getWorksheet('Schools');
  assert.equal(ws.rowCount, 2);
  assert.equal(ws.getRow(2).getCell(1).value, 'SCH000001');
  assert.match(String(wb.getWorksheet('Export Info').getRow(3).getCell(2).value), /registered=yes/);
});

test('16. Google Sheets outage: no crash, error logged, last success kept, retry without duplicates', async () => {
  const before = (await db.query('SELECT last_successful_sync FROM data_sources WHERE source_id=$1', [S.master.source_id])).rows[0].last_successful_sync;
  const schools = await count('SELECT count(*)::int AS n FROM schools');
  h.setOutage('crm', 'School Master', true);
  const fail = await admin.post(`/api/sources/${S.master.source_id}/sync`);
  assert.equal(fail.status, 200);
  assert.equal(fail.body.status, 'FAILED');
  assert.match(fail.body.message, /unavailable/);
  const src = (await db.query('SELECT * FROM data_sources WHERE source_id=$1', [S.master.source_id])).rows[0];
  assert.equal(src.connection_status, 'SYNC_ERROR');
  assert.equal(src.consecutive_failures, 1);
  assert.equal(src.last_successful_sync.toISOString(), before.toISOString());
  const status = (await admin.get('/api/integration/status')).body;
  assert.equal(status.overall, 'SYNC_ERROR');
  assert.ok(status.last_successful_sync);
  // CRM keeps working from the database
  assert.equal((await metrics()).schools, schools);
  // backoff: retried after 1 minute, not the full 15 minute frequency
  assert.equal(isDue({ ...src, last_sync: new Date(Date.now() - 61000) }), true);
  assert.equal(isDue({ ...src, consecutive_failures: 0, last_sync: new Date(Date.now() - 61000) }), false);
  // test connection reports the error without throwing
  const t = await admin.post(`/api/sources/${S.master.source_id}/test`);
  assert.equal(t.body.ok, false);
  // recovery: sync succeeds and creates nothing new
  h.setOutage('crm', 'School Master', false);
  const ok = (await admin.post(`/api/sources/${S.master.source_id}/sync`)).body;
  assert.equal(ok.rows_created, 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM schools'), schools);
  const after = (await db.query('SELECT * FROM data_sources WHERE source_id=$1', [S.master.source_id])).rows[0];
  assert.equal(after.connection_status, 'CONNECTED'); assert.equal(after.consecutive_failures, 0);

  // a sheet whose headers cannot be mapped fails cleanly without partial writes
  h.writeSheet('crm', 'Weird', [['Foo', 'Bar'], ['1', '2']]);
  const weird = await h.addSource({ source_name: 'Weird', spreadsheet_id: 'crm', sheet_name: 'Weird', source_type: 'SCHOOL_REGISTRATION' });
  const w = await syncSource(weird.source_id, { triggeredBy: 'test' });
  assert.equal(w.status, 'FAILED');
  assert.match(w.message, /School Name/);
  // a per-source mapping override fixes it without code changes
  h.writeSheet('crm', 'Weird', [['Foo', 'Bar'], ['XYZ Public School', 'Mumbai']]);
  await admin.patch(`/api/sources/${weird.source_id}`, { column_mapping: { Foo: 'school_name', Bar: 'city' } });
  const w2 = await syncSource(weird.source_id, { triggeredBy: 'test' });
  assert.equal(w2.status, 'SUCCESS');
  assert.equal((await db.query(`SELECT school_registered FROM schools WHERE school_id='SCH000002'`)).rows[0].school_registered, true);
});

test('16b. Google adapter: service-account auth, retry on 503, credentials never required by the UI', async () => {
  const config = require('../src/config');
  const google = require('../src/sheets/googleAdapter');
  await assert.rejects(google.readSheet({ spreadsheet_id: 'x', sheet_name: 'S' }), /credentials are not configured/);
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  config.googleServiceAccountJson = JSON.stringify({ client_email: 'crm@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const realFetch = global.fetch; const calls = [];
  let sheetCalls = 0;
  global.fetch = async (url, opts) => {
    calls.push(String(url));
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      const assertion = new URLSearchParams(opts.body.toString()).get('assertion');
      const claim = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url'));
      assert.equal(claim.iss, 'crm@proj.iam.gserviceaccount.com');
      assert.match(claim.scope, /spreadsheets/);
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    assert.equal(opts.headers.authorization, 'Bearer tok');
    sheetCalls++;
    if (sheetCalls === 1) return new Response('{"error":{"message":"Backend Error"}}', { status: 503 });
    return new Response(JSON.stringify({ values: [['School Name', 'City'], ['ABC School', 'Pune'], [], ['XYZ', 'Mumbai']] }), { status: 200 });
  };
  try {
    const out = await google.readSheet({ spreadsheet_id: 'sheet123', sheet_name: 'School Master', header_row: 1 });
    assert.deepEqual(out.headers, ['School Name', 'City']);
    assert.deepEqual(out.rows.map((r) => r.rowNumber), [2, 4]);
    assert.equal(sheetCalls, 2); // retried after 503
    assert.ok(calls.some((u) => u.includes("values/'School%20Master'!A%3AZZ") || u.includes('values/%27School%20Master%27!A%3AZZ')), calls.join('\n'));
    // non-retryable 403 surfaces a clear error
    global.fetch = async (url) => (String(url).includes('oauth2') ? new Response(JSON.stringify({ access_token: 'tok' })) : new Response('{"error":{"message":"The caller does not have permission"}}', { status: 403 }));
    await assert.rejects(google.writeCells({ spreadsheet_id: 's', sheet_name: 'S' }, [{ rowNumber: 2, colIndex: 15, value: 'SCH000001' }]), /403: The caller does not have permission/);
  } finally {
    global.fetch = realFetch; config.googleServiceAccountJson = '';
  }
  // no secret material is exposed through the API
  const st = (await admin.get('/api/integration/status')).body;
  assert.deepEqual(Object.keys(st).sort(), ['errors', 'google_credentials_configured', 'last_successful_sync', 'open_reviews', 'overall', 'sources']);
});

test('audit trail: manual changes keep old and new values', async () => {
  const a = (await db.query(`SELECT * FROM audit_logs WHERE entity_id='SCH000002' AND field='district' ORDER BY audit_id DESC LIMIT 1`)).rows[0];
  assert.equal(a.old_value, 'Mumbai City'); assert.equal(a.new_value, 'Mumbai Suburban');
  assert.match(a.changed_by, /^user:\d+ admin@test\.in$/); assert.equal(a.change_source, 'MANUAL');
  // a manual district wins over the sheet and is written back to the sheet's District column
  await syncSource(S.master.source_id, { triggeredBy: 'test' });
  assert.equal((await db.query(`SELECT district FROM schools WHERE school_id='SCH000002'`)).rows[0].district, 'Mumbai Suburban');
  assert.equal(h.readSheet('crm', 'School Master').find((r) => r[15] === 'SCH000002')[16], 'Mumbai Suburban');
  // a District typed into the sheet for a non-manual school is picked up
  const sheet = h.readSheet('crm', 'School Master');
  sheet.find((r) => r[15] === 'SCH000004')[16] = 'Lucknow Cantonment';
  h.writeSheet('crm', 'School Master', sheet);
  await syncSource(S.master.source_id, { triggeredBy: 'test' });
  assert.equal((await db.query(`SELECT district, district_origin FROM schools WHERE school_id='SCH000004'`)).rows[0].district_origin, 'SHEET');
  const prof = (await admin.get('/api/schools/SCH000002')).body;
  assert.ok(prof.audit.length > 0);
  assert.equal((await mgmt.get('/api/audit')).status, 403);
});
