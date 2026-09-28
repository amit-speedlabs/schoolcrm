'use strict';
// Google Sheets -> central database synchronisation.
//
// One sync = read the whole sheet, normalise each row through the mapping layer,
// match it to a school (School ID first, then secondary matching), and upsert
// inside ONE transaction. A failed or retried sync therefore never leaves partial
// or duplicated rows behind. Row identity + content hashes (source_rows) make
// re-syncs idempotent and let us report created / updated / unchanged counts.
const crypto = require('crypto');
const db = require('../db');
const n = require('../util/normalize');
const { adapterFor } = require('../sheets');
const mapping = require('./mapping');
const { match } = require('./matcher');
const { RefCache } = require('../services/refs');
const audit = require('../services/audit');

const SCHOOL_UPDATABLE = [
  'school_name', 'city', 'district', 'address', 'pin_code', 'state', 'board', 'principal_name', 'principal_contact',
  'school_email', 'coordinator_name', 'coordinator_phone', 'kit_drop_date', 'number_of_kits',
  'channel_id', 'partner_id', 'sales_spoc_id', 'channel_raw', 'sales_spoc_raw',
];
const AUDITED_SCHOOL_FIELDS = [...SCHOOL_UPDATABLE, 'district_origin', 'school_registered', 'registration_date'];
const ID_RE = /^SCH\d{6,}$/;

const sha1 = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex');

async function loadAliases(c) {
  const { rows } = await c.query('SELECT alias_norm, canonical_field FROM field_aliases');
  return new Map(rows.map((r) => [r.alias_norm, r.canonical_field]));
}

// ---------------------------------------------------------------------------
// Normalise a raw mapped record. Returns { val, issues }. Invalid optional values
// become warnings and are left out of `val` (so they never overwrite good data).
// ---------------------------------------------------------------------------
function normaliseRecord(rec, source) {
  const val = {}; const issues = [];
  const warn = (field, r) => { if (r.error) issues.push({ severity: 'WARNING', field, message: r.error, raw: rec[field] }); };
  const has = (f) => Object.prototype.hasOwnProperty.call(rec, f);

  if (has('school_id')) {
    const id = n.clean(rec.school_id);
    if (id) {
      const up = id.toUpperCase();
      if (ID_RE.test(up)) val.school_id = up;
      else issues.push({ severity: 'WARNING', field: 'school_id', message: `Ignoring malformed School ID "${id}"`, raw: id });
    }
  }
  if (has('school_name')) val.school_name = n.clean(rec.school_name);
  if (has('city')) val.city = n.normPlace(rec.city);
  if (has('district')) val.district = n.normPlace(rec.district);
  if (has('state')) val.state = n.normState(rec.state);
  for (const f of ['address', 'board', 'principal_name', 'coordinator_name', 'coordinator_address']) if (has(f)) val[f] = n.clean(rec[f]);
  if (has('board') && val.board) val.board = val.board.toUpperCase().length <= 6 ? val.board.toUpperCase() : val.board;
  for (const f of ['principal_contact', 'coordinator_phone']) {
    if (!has(f)) continue;
    const r = n.normPhone(rec[f]); warn(f, r); if (!r.error) val[f] = r.value;
  }
  if (has('school_email')) { const r = n.normEmail(rec.school_email); warn('school_email', r); if (!r.error) val.school_email = r.value; }
  if (has('pin_code')) { const r = n.normPin(rec.pin_code); warn('pin_code', r); if (!r.error) val.pin_code = r.value; }
  for (const f of ['kit_drop_date', 'registration_date']) {
    if (!has(f)) continue;
    const r = n.parseDate(rec[f], source.date_format); warn(f, r); if (!r.error) val[f] = r.value;
  }
  if (has('number_of_kits')) { const r = n.normCount(rec.number_of_kits, 'number of kits'); warn('number_of_kits', r); if (!r.error) val.number_of_kits = r.value; }
  for (const f of ['channel', 'partner', 'sales_spoc']) if (has(f)) val[f] = n.clean(rec[f]);
  if (has('school_registered')) { const r = n.parseYesNo(rec.school_registered); warn('school_registered', r); if (!r.error) val.school_registered = r.value; }

  // Grade counts: invalid counts are ERRORS (a wrong count would corrupt totals)
  let anyGrade = false;
  for (const f of mapping.GRADE_FIELDS) {
    if (!has(f)) continue;
    anyGrade = true;
    const r = n.normCount(rec[f], f.replace(/_count$/, '').replace('_', ' '));
    if (r.error) issues.push({ severity: 'ERROR', field: f, message: r.error, raw: rec[f] });
    else val[f] = r.value || 0;
  }
  if (!anyGrade && has('total_students')) {
    // no grade columns: keep the sheet's total as a count without a grade split
    const t = n.normCount(rec.total_students, 'total students');
    if (t.error) issues.push({ severity: 'ERROR', field: 'total_students', message: t.error, raw: rec.total_students });
    else val.ungraded_count = t.value || 0;
  }
  if (anyGrade && has('total_students')) {
    const t = n.normCount(rec.total_students, 'total students');
    const sum = mapping.GRADE_FIELDS.reduce((a, f) => a + (val[f] || 0), 0);
    if (!t.error && t.value !== null && t.value !== sum) {
      issues.push({ severity: 'WARNING', field: 'total_students', message: `Sheet total ${t.value} differs from grade-wise sum ${sum}; CRM uses ${sum}`, raw: rec.total_students });
    }
  }
  return { val, issues };
}

// ---------------------------------------------------------------------------
class SyncRun {
  constructor(client, source, syncId) {
    this.c = client; this.source = source; this.syncId = syncId;
    this.stats = { rows_read: 0, rows_created: 0, rows_updated: 0, rows_unchanged: 0, rows_flagged: 0, rows_errored: 0 };
    this.issues = [];
    this.writebacks = [];
    this.seenRowKeys = new Set();
    this.rowsFiltered = 0;
    this.touchedStudentSchools = new Set();
    this.who = `sync:${source.source_id}`;
    this.now = new Date();
  }

  issue(row, severity, field, message, raw) {
    this.issues.push({ row, severity, field, message, raw: raw === undefined ? null : String(raw).slice(0, 500) });
  }

  async prepare(headers) {
    const aliases = await loadAliases(this.c);
    this.map = mapping.buildMapping(headers, aliases, this.source.column_mapping);
    this.refs = await new RefCache(this.c, { isDemo: this.source.is_demo }).load();
    const { rows } = await this.c.query('SELECT * FROM schools');
    this.schools = rows;
    this.byId = new Map(rows.map((s) => [s.school_id, s]));
    const g = await this.c.query('SELECT state, city, district FROM geo_city_district');
    this.geo = new Map(g.rows.map((r) => [`${r.state.toLowerCase()}|${r.city.toLowerCase()}`, r.district]));
    const sr = await this.c.query('SELECT * FROM source_rows WHERE source_id = $1', [this.source.source_id]);
    this.prevRows = new Map(sr.rows.map((r) => [r.row_key, r]));
    // schools already claimed by another row of THIS source (used to detect duplicates inside a sheet)
    this.claimed = new Map();
    for (const r of sr.rows) if (r.school_id && r.state === 'LINKED') this.claimed.set(r.school_id, r.row_key);
  }

  lookupDistrict(state, city) {
    if (!state || !city) return null;
    return this.geo.get(`${state.toLowerCase()}|${city.toLowerCase()}`) || null;
  }

  // ----- school resolution -------------------------------------------------
  // returns { school } | { pending: true } | { error }
  async resolveSchool(rowNumber, rowKey, val, rowHash) {
    const type = this.source.source_type;
    if (val.school_id) {
      const s = this.byId.get(val.school_id);
      if (s) return { school: s };
      if (type === 'SCHOOL_MASTER') return { newId: val.school_id }; // rebuild from sheet: keep the sheet's ID
      return { error: `School ID ${val.school_id} does not exist in the CRM` };
    }
    // Previously linked (or reviewed) row
    const prev = this.prevRows.get(rowKey);
    if (prev && prev.state === 'LINKED' && prev.school_id && this.byId.has(prev.school_id)) {
      const s = this.byId.get(prev.school_id);
      // guard against rows being re-ordered in the sheet: the name must still resemble the linked school
      if (prev.reviewed || !val.school_name || n.similarity(val.school_name, s.school_name) >= 0.6) return { school: s };
    }
    if (prev && prev.state === 'REJECTED' && prev.row_hash === rowHash) return { skip: true };
    const open = await this.c.query(`SELECT review_id FROM duplicate_reviews WHERE source_id=$1 AND row_key=$2 AND status='OPEN'`, [this.source.source_id, rowKey]);

    if (!val.school_name) return { error: 'School name is required when School ID is not provided' };
    const inc = {
      school_name: val.school_name, city: val.city, principal_contact: val.principal_contact,
      school_email: val.school_email, coordinator_phone: val.coordinator_phone, pin_code: val.pin_code,
    };
    const res = match(inc, this.schools, {
      // inside the School Master, a school already owned by a different row is a duplicate row, never auto-linked
      exclude: (id) => type === 'SCHOOL_MASTER' && this.claimed.has(id) && this.claimed.get(id) !== rowKey,
    });
    if (res.decision === 'MATCH') return { school: this.byId.get(res.school_id), matchedBy: res.candidates[0].reasons };
    if (res.decision === 'NONE' && type === 'SCHOOL_MASTER') return { create: true };

    // Park the row for admin review (never auto-create a possible duplicate)
    const kind = res.decision === 'REVIEW' ? 'POSSIBLE_DUPLICATE' : 'UNMATCHED';
    const incoming = { ...val, _source_row: rowNumber };
    if (open.rows.length) {
      await this.c.query(`UPDATE duplicate_reviews SET incoming=$1, candidates=$2, kind=$3, source_row=$4, updated_at=now() WHERE review_id=$5`,
        [incoming, JSON.stringify(res.candidates), kind, rowNumber, open.rows[0].review_id]);
    } else {
      await this.c.query(`INSERT INTO duplicate_reviews (source_id, source_row, row_key, kind, incoming, candidates) VALUES ($1,$2,$3,$4,$5,$6)`,
        [this.source.source_id, rowNumber, rowKey, kind, incoming, JSON.stringify(res.candidates)]);
    }
    return { pending: true, kind };
  }

  // ----- school master upsert ----------------------------------------------
  async schoolValuesFromRow(val, existing) {
    const out = {};
    const mapped = this.map.byField;
    for (const f of ['school_name', 'city', 'address', 'pin_code', 'state', 'board', 'principal_name', 'principal_contact',
      'school_email', 'coordinator_name', 'coordinator_phone', 'kit_drop_date', 'number_of_kits']) {
      if (mapped[f] === undefined) continue;             // column not in this sheet -> leave CRM value alone
      if (!(f in val)) continue;                          // invalid value -> keep existing (warning logged)
      out[f] = val[f];
    }
    if (mapped.channel !== undefined) {
      out.channel_raw = val.channel || null;
      out.channel_id = await this.refs.channel(val.channel);
    }
    if (mapped.partner !== undefined) {
      const ch = out.channel_id !== undefined ? out.channel_id : existing?.channel_id;
      out.partner_id = await this.refs.partner(val.partner, ch || null);
    }
    if (mapped.sales_spoc !== undefined) {
      out.sales_spoc_raw = val.sales_spoc || null;
      out.sales_spoc_id = await this.refs.spoc(val.sales_spoc);
    }
    // District: sheet value wins; otherwise derive from City (never overwrite a manual district)
    const state = out.state !== undefined ? out.state : existing?.state;
    const city = out.city !== undefined ? out.city : existing?.city;
    if (existing?.district_origin === 'MANUAL') {
      // a district set by an admin in the CRM wins (and is written back to the sheet)
    } else if (mapped.district !== undefined && val.district) {
      out.district = val.district; out.district_origin = 'SHEET';
    } else {
      const d = this.lookupDistrict(state, city);
      if (d || existing?.district_origin !== 'SHEET' || mapped.district !== undefined) {
        out.district = d; out.district_origin = d ? 'LOOKUP' : null;
      }
    }
    return out;
  }

  async createSchool(values, { schoolId, rowNumber }) {
    const cols = ['school_name', ...Object.keys(values).filter((k) => k !== 'school_name'),
      'source', 'source_id', 'source_sheet', 'source_row', 'last_synced_at', 'is_demo', 'created_by', 'updated_by'];
    const vals = [values.school_name, ...Object.keys(values).filter((k) => k !== 'school_name').map((k) => values[k]),
      this.source.is_demo ? 'DEMO' : 'GOOGLE_SHEETS', this.source.source_id, this.source.sheet_name, rowNumber, this.now,
      this.source.is_demo, this.who, this.who];
    if (schoolId) { cols.unshift('school_id'); vals.unshift(schoolId); }
    const { rows } = await this.c.query(
      `INSERT INTO schools (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals);
    if (schoolId) {
      await this.c.query(`SELECT setval('school_id_seq', GREATEST((SELECT last_value FROM school_id_seq), $1::bigint))`, [Number(schoolId.slice(3))]);
    }
    const s = rows[0];
    await audit.logAction(this.c, { entityType: 'school', entityId: s.school_id, action: 'CREATE', note: `Created from ${this.source.source_name} row ${rowNumber}`, changedBy: this.who, changeSource: 'SYNC' });
    this.schools.push(s); this.byId.set(s.school_id, s);
    return s;
  }

  async updateSchool(existing, values, rowNumber, { lineage = true } = {}) {
    const changed = Object.keys(values).filter((k) => String(values[k] ?? '') !== String(existing[k] ?? ''));
    const sets = changed.map((k, i) => `${k} = $${i + 2}`);
    const params = [existing.school_id, ...changed.map((k) => values[k])];
    if (lineage) {
      params.push(this.source.sheet_name, rowNumber, this.source.source_id);
      sets.push(`source_sheet = $${params.length - 2}`, `source_row = $${params.length - 1}`, `source_id = $${params.length}`);
    }
    sets.push('last_synced_at = now()');
    if (changed.length) sets.push('updated_at = now()', `updated_by = '${this.who}'`);
    const { rows } = await this.c.query(`UPDATE schools SET ${sets.join(', ')} WHERE school_id = $1 RETURNING *`, params);
    const s = rows[0];
    if (changed.length) {
      await audit.logChanges(this.c, { entityType: 'school', entityId: s.school_id, before: existing, after: s, fields: changed.filter((f) => AUDITED_SCHOOL_FIELDS.includes(f)), changedBy: this.who, changeSource: 'SYNC' });
    }
    Object.assign(existing, s);
    return changed.length > 0;
  }

  async upsertContacts(school, val) {
    const pairs = [
      ['PRINCIPAL', this.map.byField.principal_name !== undefined || this.map.byField.principal_contact !== undefined,
        { name: school.principal_name, phone: school.principal_contact, email: null, address: null }],
      ['COORDINATOR', this.map.byField.coordinator_name !== undefined || this.map.byField.coordinator_phone !== undefined,
        { name: school.coordinator_name, phone: school.coordinator_phone, email: null, address: val.coordinator_address || null }],
    ];
    for (const [type, present, c] of pairs) {
      if (!present) continue;
      if (!c.name && !c.phone) {
        await this.c.query(`DELETE FROM school_contacts WHERE school_id=$1 AND contact_type=$2 AND is_primary AND source='SYNC'`, [school.school_id, type]);
        continue;
      }
      await this.c.query(
        `INSERT INTO school_contacts (school_id, contact_type, name, phone, address, is_primary, source)
         VALUES ($1,$2,$3,$4,$5,TRUE,'SYNC')
         ON CONFLICT (school_id, contact_type) WHERE is_primary AND contact_type IN ('PRINCIPAL','COORDINATOR')
         DO UPDATE SET name=EXCLUDED.name, phone=EXCLUDED.phone, address=COALESCE(EXCLUDED.address, school_contacts.address), updated_at=now()`,
        [school.school_id, type, c.name, c.phone, c.address]);
    }
  }

  // ----- per-type row handlers ----------------------------------------------
  async applySchoolMaster(res, val, rowNumber, sheetIdCell) {
    let school = res.school; let created = false;
    if (res.create || res.newId) {
      if (!val.school_name) throw new RowError('School name is required');
      const values = await this.schoolValuesFromRow(val, null);
      school = await this.createSchool(values, { schoolId: res.newId, rowNumber });
      created = true;
    } else {
      const values = await this.schoolValuesFromRow(val, school);
      if (values.school_name === null) delete values.school_name; // never blank out a name
      const changed = await this.updateSchool(school, values, rowNumber);
      if (!changed) this._unchangedHint = true;
    }
    await this.upsertContacts(school, val);
    if (this.source.writeback_enabled) {
      if (sheetIdCell !== school.school_id) this.writebacks.push({ rowNumber, field: 'school_id', value: school.school_id });
      if (school.district && val.district !== school.district) this.writebacks.push({ rowNumber, field: 'district', value: school.district });
    }
    return { school, created };
  }

  async applyRegistration(school, val, rowNumber) {
    const registered = val.school_registered === undefined || val.school_registered === null ? true : val.school_registered;
    const values = { school_registered: registered };
    if (registered) {
      // keep the earliest registration date across responses/sources
      // keep the earliest known registration date across responses/sources
      const dates = [val.registration_date, school.school_registered ? school.registration_date : null].filter(Boolean).sort();
      values.registration_date = dates[0] || null;
      values.registration_source = this.source.source_name;
      values.registration_form = this.source.form_url || `${this.source.sheet_name}`;
    }
    const before = { ...school };
    const changed = Object.keys(values).filter((k) => String(values[k] ?? '') !== String(school[k] ?? ''));
    const params = [school.school_id, ...changed.map((k) => values[k])];
    const sets = changed.map((k, i) => `${k} = $${i + 2}`);
    sets.push('last_registration_sync = now()');
    if (changed.length) sets.push('updated_at = now()', `updated_by = '${this.who}'`);
    const { rows } = await this.c.query(`UPDATE schools SET ${sets.join(', ')} WHERE school_id=$1 RETURNING *`, params);
    Object.assign(school, rows[0]);
    if (changed.length) await audit.logChanges(this.c, { entityType: 'school', entityId: school.school_id, before, after: school, fields: changed.filter((f) => AUDITED_SCHOOL_FIELDS.includes(f)), changedBy: this.who, changeSource: 'SYNC' });
    return changed.length > 0;
  }

  async applyStudents(school, val, rowNumber) {
    const grades = [...mapping.GRADE_FIELDS.map((f) => val[f] || 0), val.ungraded_count || 0];
    const { rows: prev } = await this.c.query('SELECT * FROM student_registrations WHERE source_id=$1 AND source_row=$2', [this.source.source_id, rowNumber]);
    const params = [school.school_id, val.registration_date || null, ...grades, this.source.is_demo ? 'DEMO' : 'GOOGLE_SHEETS',
      this.source.source_id, this.source.sheet_name, rowNumber, this.source.is_demo, this.who];
    const { rows } = await this.c.query(
      `INSERT INTO student_registrations (school_id, registration_date, grade_3_count, grade_4_count, grade_5_count, grade_6_count,
         grade_7_count, grade_8_count, grade_9_count, grade_10_count, ungraded_count, source, source_id, source_sheet, source_row, is_demo, created_by, updated_by, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17, now())
       ON CONFLICT (source_id, source_row) WHERE source_id IS NOT NULL DO UPDATE SET
         school_id=EXCLUDED.school_id, registration_date=EXCLUDED.registration_date,
         grade_3_count=EXCLUDED.grade_3_count, grade_4_count=EXCLUDED.grade_4_count, grade_5_count=EXCLUDED.grade_5_count,
         grade_6_count=EXCLUDED.grade_6_count, grade_7_count=EXCLUDED.grade_7_count, grade_8_count=EXCLUDED.grade_8_count,
         grade_9_count=EXCLUDED.grade_9_count, grade_10_count=EXCLUDED.grade_10_count, ungraded_count=EXCLUDED.ungraded_count, last_synced_at=now(),
         updated_at=now(), updated_by=EXCLUDED.updated_by
       RETURNING *`, params);
    this.touchedStudentSchools.add(school.school_id);
    if (prev[0] && prev[0].school_id !== school.school_id) this.touchedStudentSchools.add(prev[0].school_id);
    const fields = ['school_id', 'registration_date', ...mapping.GRADE_FIELDS, 'ungraded_count', 'total_students'];
    await audit.logChanges(this.c, { entityType: 'student_registration', entityId: rows[0].registration_id, before: prev[0] || null, after: rows[0], fields, changedBy: this.who, changeSource: 'SYNC' });
  }

  async applyKit(school, val, rowNumber) {
    const values = {};
    if ('kit_drop_date' in val && val.kit_drop_date) values.kit_drop_date = val.kit_drop_date;
    if ('number_of_kits' in val && val.number_of_kits !== null) values.number_of_kits = val.number_of_kits;
    if (val.channel) { values.channel_raw = val.channel; values.channel_id = await this.refs.channel(val.channel); }
    if (val.partner) values.partner_id = await this.refs.partner(val.partner, values.channel_id || school.channel_id || null);
    if (val.sales_spoc) { values.sales_spoc_raw = val.sales_spoc; values.sales_spoc_id = await this.refs.spoc(val.sales_spoc); }
    return this.updateSchool(school, values, rowNumber, { lineage: false });
  }

  // ----- main row loop -----------------------------------------------------
  async processRow(row) {
    const type = this.source.source_type;
    const rec = mapping.extract(this.map, row.values);
    const { val, issues } = normaliseRecord(rec, this.source);
    for (const i of issues) this.issue(row.rowNumber, i.severity, i.field, i.message, i.raw);
    if (issues.some((i) => i.severity === 'ERROR')) throw new RowError('Row rejected due to invalid values', true);
    if (!val.school_id && !val.school_name) throw new RowError('Row has neither School ID nor School Name');

    const sheetIdCell = n.clean(rec.school_id) ? n.clean(rec.school_id).toUpperCase() : null;
    const rowKey = `row:${row.rowNumber}`;
    const hashInput = { ...rec }; delete hashInput.school_id; delete hashInput.district; // write-back columns don't count as changes
    const rowHash = sha1({ m: this.map.columns.map((c) => c.field).filter((f) => f !== 'school_id' && f !== 'district'), r: hashInput });
    this.seenRowKeys.add(rowKey);

    const prev = this.prevRows.get(rowKey);
    const prevSchool = prev && prev.school_id ? this.byId.get(prev.school_id) : null;
    const districtEdited = type === 'SCHOOL_MASTER' && prevSchool && val.district && val.district !== prevSchool.district && prevSchool.district_origin !== 'MANUAL';
    if (prev && prev.row_hash === rowHash && prev.state === 'LINKED' && prevSchool && !districtEdited
        && (!val.school_id || val.school_id === prev.school_id)) {
      // unchanged row: only refresh lineage, and still queue a missing School ID write-back
      await this.c.query('UPDATE source_rows SET last_seen_at=now(), source_row=$3 WHERE source_id=$1 AND row_key=$2', [this.source.source_id, rowKey, row.rowNumber]);
      if (type === 'SCHOOL_MASTER') {
        await this.c.query('UPDATE schools SET last_synced_at=now() WHERE school_id=$1', [prev.school_id]);
        if (this.source.writeback_enabled && sheetIdCell !== prev.school_id) this.writebacks.push({ rowNumber: row.rowNumber, field: 'school_id', value: prev.school_id });
        const s = this.byId.get(prev.school_id);
        if (this.source.writeback_enabled && s.district && val.district !== s.district) this.writebacks.push({ rowNumber: row.rowNumber, field: 'district', value: s.district });
      }
      if (type === 'STUDENT_REGISTRATION' || type === 'COMBINED_REGISTRATION') this.touchedStudentSchools.add(prev.school_id);
      this.stats.rows_unchanged++;
      return;
    }

    const res = await this.resolveSchool(row.rowNumber, rowKey, val, rowHash);
    if (res.skip) { this.stats.rows_unchanged++; return; }
    if (res.error) throw new RowError(res.error);
    if (res.pending) {
      await this.saveSourceRow(rowKey, row.rowNumber, rowHash, null, 'PENDING_REVIEW', rec);
      this.stats.rows_flagged++;
      this.issue(row.rowNumber, 'WARNING', 'school_name', res.kind === 'POSSIBLE_DUPLICATE'
        ? `Possible duplicate of an existing school - sent to Admin review ("${val.school_name}")`
        : `No matching school found - sent to Admin review ("${val.school_name}")`, val.school_name);
      return;
    }

    let school = res.school; let created = false; let changed = true;
    if (type === 'SCHOOL_MASTER') {
      this._unchangedHint = false;
      ({ school, created } = await this.applySchoolMaster(res, val, row.rowNumber, sheetIdCell));
      changed = created || !this._unchangedHint;
    } else {
      if (type === 'SCHOOL_REGISTRATION' || type === 'COMBINED_REGISTRATION') await this.applyRegistration(school, val, row.rowNumber);
      if ((type === 'STUDENT_REGISTRATION' || type === 'COMBINED_REGISTRATION') && [...mapping.GRADE_FIELDS, 'total_students'].some((f) => this.map.byField[f] !== undefined)) {
        await this.applyStudents(school, val, row.rowNumber);
      }
      if (type === 'KIT_DISTRIBUTION') await this.applyKit(school, val, row.rowNumber);
    }
    await this.saveSourceRow(rowKey, row.rowNumber, rowHash, school.school_id, 'LINKED', rec);
    this.claimed.set(school.school_id, rowKey);
    await this.c.query(`UPDATE duplicate_reviews SET status='LINKED', resolved_school_id=$3, resolved_by=$4, resolved_at=now(), updated_at=now()
                        WHERE source_id=$1 AND row_key=$2 AND status='OPEN'`, [this.source.source_id, rowKey, school.school_id, this.who]);
    if (created) this.stats.rows_created++;
    else if (changed || !prev) this.stats.rows_updated++;
    else this.stats.rows_unchanged++;
  }

  async saveSourceRow(rowKey, rowNumber, rowHash, schoolId, state, raw) {
    await this.c.query(
      `INSERT INTO source_rows (source_id, row_key, source_row, row_hash, school_id, state, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (source_id, row_key) DO UPDATE SET source_row=EXCLUDED.source_row, row_hash=EXCLUDED.row_hash,
         school_id=EXCLUDED.school_id, state=EXCLUDED.state, raw=EXCLUDED.raw, last_seen_at=now(),
         reviewed = source_rows.reviewed AND EXCLUDED.school_id IS NOT DISTINCT FROM source_rows.school_id`,
      [this.source.source_id, rowKey, rowNumber, rowHash, schoolId, state, raw]);
  }

  // Rows removed from the sheet: drop their student counts (latest synced data wins).
  // School records are never deleted automatically.
  async handleRemovedRows(totalRows) {
    if (!totalRows) return; // an empty read is suspicious; never mass-delete on it
    const gone = [...this.prevRows.keys()].filter((k) => !this.seenRowKeys.has(k));
    for (const k of gone) {
      const r = this.prevRows.get(k);
      const { rows } = await this.c.query('DELETE FROM student_registrations WHERE source_id=$1 AND source_row=$2 RETURNING *', [this.source.source_id, r.source_row]);
      for (const d of rows) {
        this.touchedStudentSchools.add(d.school_id);
        await audit.logAction(this.c, { entityType: 'student_registration', entityId: d.registration_id, action: 'DELETE', note: `Row ${r.source_row} no longer present in ${this.source.sheet_name}`, changedBy: this.who, changeSource: 'SYNC' });
      }
      await this.c.query('DELETE FROM source_rows WHERE source_id=$1 AND row_key=$2', [this.source.source_id, k]);
      await this.c.query(`UPDATE duplicate_reviews SET status='DISMISSED', resolved_by=$3, resolved_at=now() WHERE source_id=$1 AND row_key=$2 AND status='OPEN'`, [this.source.source_id, k, this.who]);
    }
  }

  // student_mode LATEST: a school's newest response in this source replaces its older ones
  async applyStudentMode() {
    if (!this.touchedStudentSchools.size) return;
    const ids = [...this.touchedStudentSchools];
    if (this.source.student_mode === 'SUM') {
      await this.c.query('UPDATE student_registrations SET is_superseded=FALSE WHERE source_id=$1 AND school_id = ANY($2)', [this.source.source_id, ids]);
      return;
    }
    await this.c.query(
      `UPDATE student_registrations sr SET is_superseded = (sr.registration_id <> latest.registration_id)
       FROM (SELECT DISTINCT ON (school_id) school_id, registration_id FROM student_registrations
             WHERE source_id=$1 AND school_id = ANY($2)
             ORDER BY school_id, registration_date DESC NULLS LAST, source_row DESC) latest
       WHERE sr.source_id=$1 AND sr.school_id = latest.school_id`, [this.source.source_id, ids]);
  }
}

class RowError extends Error { constructor(m, alreadyLogged) { super(m); this.alreadyLogged = alreadyLogged; } }

// ---------------------------------------------------------------------------
// Write-back: School ID (and District where blank) into the School Master sheet.
// New columns are appended at the end of the header row; existing columns are
// never renamed, moved or removed.
// ---------------------------------------------------------------------------
async function performWriteback(adapter, source, headers, map, writebacks) {
  if (!writebacks.length) return 0;
  const updates = [];
  let nextCol = headers.length;
  const colFor = {};
  for (const [field, header] of [['school_id', 'School ID'], ['district', 'District']]) {
    if (!writebacks.some((w) => w.field === field)) continue;
    if (map.byField[field] !== undefined) colFor[field] = map.byField[field];
    else {
      colFor[field] = nextCol++;
      updates.push({ rowNumber: source.header_row || 1, colIndex: colFor[field], value: header });
    }
  }
  for (const w of writebacks) updates.push({ rowNumber: w.rowNumber, colIndex: colFor[w.field], value: w.value });
  await adapter.writeCells(source, updates);
  return writebacks.length;
}

// ---------------------------------------------------------------------------
async function syncSource(sourceId, { triggeredBy = 'scheduler' } = {}) {
  const lockClient = await db.getPool().connect();
  const lockKey = 7340000 + Number(sourceId);
  try {
    const got = await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [lockKey]);
    if (!got.rows[0].ok) return { status: 'SKIPPED', message: 'A sync for this source is already running' };
    try {
      return await runSync(sourceId, triggeredBy);
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    }
  } finally {
    lockClient.release();
  }
}

async function runSync(sourceId, triggeredBy) {
  const { rows: [source] } = await db.query('SELECT * FROM data_sources WHERE source_id=$1', [sourceId]);
  if (!source) throw new Error(`Source ${sourceId} not found`);
  const { rows: [log] } = await db.query('INSERT INTO sync_logs (source_id, triggered_by) VALUES ($1,$2) RETURNING sync_id', [sourceId, triggeredBy]);
  const adapter = adapterFor(source);

  const fail = async (message, extra = {}) => {
    await db.query(`UPDATE sync_logs SET status='FAILED', finished_at=now(), message=$2, unmapped_headers=$3 WHERE sync_id=$1`, [log.sync_id, message, extra.unmapped || []]);
    await db.query(`UPDATE data_sources SET connection_status='SYNC_ERROR', last_sync=now(), last_error=$2, consecutive_failures=consecutive_failures+1, updated_at=now() WHERE source_id=$1`, [sourceId, message]);
    return { status: 'FAILED', sync_id: log.sync_id, message };
  };

  let sheet;
  try {
    sheet = await adapter.readSheet(source);
  } catch (e) {
    return fail(e.message);
  }

  let run;
  try {
    run = await db.tx(async (client) => {
      const r = new SyncRun(client, source, log.sync_id);
      await r.prepare(sheet.headers);
      if (r.map.byField.school_name === undefined && r.map.byField.school_id === undefined) {
        throw new MappingError(`No "School Name" or "School ID" column could be identified. Headers found: ${sheet.headers.join(', ')}`, r.map.unmapped);
      }
      if (source.source_type === 'SCHOOL_MASTER' && r.map.byField.school_name === undefined) {
        throw new MappingError('School Master sheet must have a School Name column', r.map.unmapped);
      }
      let keep;
      try { keep = mapping.rowFilter(sheet.headers, source.row_filter); } catch (e) { throw new MappingError(e.message, r.map.unmapped); }
      for (const row of sheet.rows) {
        if (!keep(row.values)) { r.rowsFiltered++; continue; }
        r.stats.rows_read++;
        await client.query('SAVEPOINT row_sp');
        try {
          await r.processRow(row);
          await client.query('RELEASE SAVEPOINT row_sp');
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT row_sp');
          // RowError = validation failure; anything else = unexpected DB error for this row. Record and continue.
          r.issue(row.rowNumber, 'ERROR', null, e instanceof RowError ? e.message : `Row failed: ${e.message}`);
          r.stats.rows_errored++;
        }
      }
      await r.handleRemovedRows(sheet.rows.length);
      await r.applyStudentMode();
      for (const i of r.issues) {
        await client.query('INSERT INTO sync_row_issues (sync_id, source_row, severity, field, message, raw_value) VALUES ($1,$2,$3,$4,$5,$6)',
          [log.sync_id, i.row, i.severity, i.field, i.message, i.raw]);
      }
      return r;
    });
  } catch (e) {
    return fail(e.message, { unmapped: e.unmapped });
  }

  let writebackCount = 0; let writebackError = null;
  if (source.writeback_enabled && source.source_type === 'SCHOOL_MASTER' && run.writebacks.length) {
    try { writebackCount = await performWriteback(adapter, source, sheet.headers, run.map, run.writebacks); }
    catch (e) { writebackError = `Data synced, but writing School IDs back to the sheet failed: ${e.message}`; }
  }

  const s = run.stats;
  const status = writebackError || s.rows_errored ? 'PARTIAL' : 'SUCCESS';
  const msgParts = [`${s.rows_read} rows read: ${s.rows_created} created, ${s.rows_updated} updated, ${s.rows_unchanged} unchanged, ${s.rows_flagged} sent to review, ${s.rows_errored} rejected`];
  if (run.rowsFiltered) msgParts.push(`${run.rowsFiltered} rows skipped by the row filter`);
  if (writebackCount) msgParts.push(`${writebackCount} cells written back to sheet`);
  if (writebackError) msgParts.push(writebackError);
  await db.query(
    `UPDATE sync_logs SET status=$2, finished_at=now(), rows_read=$3, rows_created=$4, rows_updated=$5, rows_unchanged=$6,
       rows_flagged=$7, rows_errored=$8, writeback_count=$9, message=$10, unmapped_headers=$11 WHERE sync_id=$1`,
    [log.sync_id, status, s.rows_read, s.rows_created, s.rows_updated, s.rows_unchanged, s.rows_flagged, s.rows_errored,
      writebackCount, msgParts.join('. '), run.map.unmapped]);
  await db.query(
    `UPDATE data_sources SET connection_status='CONNECTED', last_sync=now(), last_successful_sync=now(),
       last_error=$2, consecutive_failures=0, updated_at=now() WHERE source_id=$1`, [sourceId, writebackError]);
  return { status, sync_id: log.sync_id, ...s, writeback_count: writebackCount, unmapped_headers: run.map.unmapped, message: msgParts.join('. ') };
}

class MappingError extends Error { constructor(m, unmapped) { super(m); this.unmapped = unmapped; } }

// Order matters: schools must exist before registrations can attach to them.
const TYPE_ORDER = ['SCHOOL_MASTER', 'KIT_DISTRIBUTION', 'SCHOOL_REGISTRATION', 'COMBINED_REGISTRATION', 'STUDENT_REGISTRATION'];
async function syncAll({ triggeredBy = 'scheduler', onlyDue = false } = {}) {
  const { rows } = await db.query(`SELECT * FROM data_sources WHERE status='ENABLED'`);
  rows.sort((a, b) => TYPE_ORDER.indexOf(a.source_type) - TYPE_ORDER.indexOf(b.source_type) || a.source_id - b.source_id);
  const results = [];
  for (const s of rows) {
    if (onlyDue && !isDue(s)) continue;
    results.push({ source_id: s.source_id, source_name: s.source_name, ...(await syncSource(s.source_id, { triggeredBy })) });
  }
  return results;
}

// Retry policy: failing sources are retried with backoff 1, 2, 4, 8 ... minutes (capped at the source's frequency).
function isDue(s, now = Date.now()) {
  if (!s.last_sync) return true;
  const freq = s.sync_frequency_minutes;
  const wait = s.consecutive_failures > 0 ? Math.min(freq, 2 ** (s.consecutive_failures - 1)) : freq;
  return now - new Date(s.last_sync).getTime() >= wait * 60000;
}

module.exports = { syncSource, syncAll, isDue, normaliseRecord, SyncRun, TYPE_ORDER };
