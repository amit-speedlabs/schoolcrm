'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const schools = require('../services/schools');
const { exportSchools } = require('../services/export');
const { validateSchool, validateStudentRegistration, ValidationError } = require('../services/validate');
const audit = require('../services/audit');
const { syncSource, syncAll } = require('../sync/syncEngine');
const { resolveReview } = require('../sync/reviews');
const { adapterFor } = require('../sheets');
const google = require('../sheets/googleAdapter');
const mapping = require('../sync/mapping');
const n = require('../util/normalize');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const who = (req) => `user:${req.user.user_id} ${req.user.email}`;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ---------------------------------------------------------------- auth
router.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw bad('Email and password are required');
  const { rows: [u] } = await db.query(
    `SELECT * FROM users WHERE lower(email)=lower($1) AND status='ACTIVE' AND access_role IN ('ADMIN','MANAGEMENT')`, [email]);
  if (!u || !auth.verifyPassword(password, u.password_hash)) throw bad('Invalid email or password', 401);
  await auth.createSession(res, u.user_id);
  res.json({ user: { user_id: u.user_id, name: u.name, email: u.email, access_role: u.access_role } });
}));
router.post('/auth/logout', wrap(async (req, res) => { await auth.destroySession(req, res); res.json({ ok: true }); }));
router.get('/auth/me', (req, res) => (req.user ? res.json({ user: req.user }) : res.status(401).json({ error: 'Not logged in' })));

router.use(auth.requireLogin);
const admin = auth.requireAdmin;

// ---------------------------------------------------------------- lookups (filter dropdowns)
router.get('/lookups', wrap(async (req, res) => {
  const [geo, boards, channels, partners, users, demo] = await Promise.all([
    db.query(`SELECT DISTINCT state, district, city FROM schools ORDER BY 1,2,3`),
    db.query(`SELECT DISTINCT board FROM schools WHERE board IS NOT NULL ORDER BY 1`),
    db.query(`SELECT * FROM channels ORDER BY lower(name)`),
    db.query(`SELECT p.*, c.name AS channel_name FROM partners p LEFT JOIN channels c USING (channel_id) ORDER BY lower(p.name)`),
    db.query(`SELECT user_id, name, email, team, role, access_role, state, city, status FROM users ORDER BY lower(name)`),
    db.query(`SELECT count(*) FILTER (WHERE is_demo)::int AS demo, count(*) FILTER (WHERE NOT is_demo)::int AS real FROM schools`),
  ]);
  res.json({
    geo: geo.rows, boards: boards.rows.map((r) => r.board), channels: channels.rows, partners: partners.rows,
    users: users.rows, demo: demo.rows[0],
  });
}));

// ---------------------------------------------------------------- dashboard
router.get('/dashboard/metrics', wrap(async (req, res) => res.json(await schools.metrics(req.query))));
router.get('/dashboard/breakdown/:dimension', wrap(async (req, res) => {
  res.json(await schools.breakdown(req.params.dimension, req.query, { sort: req.query.sort, dir: req.query.dir }));
}));

// ---------------------------------------------------------------- schools
router.get('/schools', wrap(async (req, res) => {
  const { page, pageSize, sort, dir } = req.query;
  res.json(await schools.listSchools(req.query, { page, pageSize, sort, dir }));
}));
router.get('/schools/export', wrap(async (req, res) => {
  const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
  const out = await exportSchools(req.query, format, { sort: req.query.sort, dir: req.query.dir });
  res.setHeader('Content-Type', out.type);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('X-Row-Count', String(out.count));
  res.send(Buffer.isBuffer(out.body) ? out.body : Buffer.from(out.body));
}));
router.get('/schools/:id', wrap(async (req, res) => {
  const s = await schools.getSchool(req.params.id.toUpperCase());
  if (!s) throw bad('School not found', 404);
  res.json(s);
}));

// Manual create (e.g. a school that is not yet in any sheet). ID is always generated.
router.post('/schools', admin, wrap(async (req, res) => {
  const v = validateSchool(req.body || {});
  const body = req.body || {};
  const created = await db.tx(async (c) => {
    // duplicate guard (same rules as sync) unless admin explicitly confirms
    if (!body.confirm_not_duplicate) {
      const { match } = require('../sync/matcher');
      const { rows: all } = await c.query('SELECT school_id, school_name, city, state, principal_contact, school_email, coordinator_phone, pin_code FROM schools');
      const m = match(v, all);
      if (m.decision !== 'NONE') throw Object.assign(bad('Possible duplicate school', 409), { candidates: m.candidates });
    }
    if (v.city && !v.state) {
      const { rows } = await c.query('SELECT DISTINCT state FROM geo_city_district WHERE lower(city)=lower($1)', [v.city]);
      if (rows.length === 1) v.state = rows[0].state;
    }
    if (v.city && v.state && !v.district) {
      const { rows } = await c.query('SELECT district FROM geo_city_district WHERE lower(state)=lower($1) AND lower(city)=lower($2)', [v.state, v.city]);
      if (rows[0]) { v.district = rows[0].district; v.district_origin = 'LOOKUP'; }
    } else if (v.district) v.district_origin = 'MANUAL';
    const cols = Object.keys(v);
    const { rows: [s] } = await c.query(
      `INSERT INTO schools (${cols.join(',')}, source, created_by, updated_by) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}, 'MANUAL', $${cols.length + 1}, $${cols.length + 1}) RETURNING *`,
      [...cols.map((k) => v[k]), who(req)]);
    await audit.logChanges(c, { entityType: 'school', entityId: s.school_id, before: null, after: s, fields: cols, changedBy: who(req) });
    return s;
  });
  res.status(201).json(created);
}));

router.patch('/schools/:id', admin, wrap(async (req, res) => {
  const body = { ...(req.body || {}) };
  delete body.school_id; // School ID can never change
  const v = validateSchool(body, { partial: true });
  if (!Object.keys(v).length) throw bad('Nothing to update');
  const updated = await db.tx(async (c) => {
    const { rows: [before] } = await c.query('SELECT * FROM schools WHERE school_id=$1 FOR UPDATE', [req.params.id]);
    if (!before) throw bad('School not found', 404);
    if ('district' in v) v.district_origin = v.district ? 'MANUAL' : null;
    if (v.partner_id) {
      const { rows } = await c.query('SELECT channel_id FROM partners WHERE partner_id=$1', [v.partner_id]);
      if (!rows[0]) throw bad('Unknown partner');
    }
    const cols = Object.keys(v);
    const { rows: [after] } = await c.query(
      `UPDATE schools SET ${cols.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now(), updated_by=$${cols.length + 2} WHERE school_id=$1 RETURNING *`,
      [req.params.id, ...cols.map((k) => v[k]), who(req)]);
    await audit.logChanges(c, { entityType: 'school', entityId: after.school_id, before, after, fields: cols, changedBy: who(req) });
    return after;
  });
  res.json(updated);
}));

router.post('/schools/:id/student-registrations', admin, wrap(async (req, res) => {
  const v = validateStudentRegistration(req.body || {});
  const row = await db.tx(async (c) => {
    const { rows: [s] } = await c.query('SELECT school_id FROM schools WHERE school_id=$1', [req.params.id]);
    if (!s) throw bad('School not found', 404);
    const cols = Object.keys(v);
    const { rows: [r] } = await c.query(
      `INSERT INTO student_registrations (school_id, ${cols.join(',')}, source, created_by, updated_by)
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(',')}, 'MANUAL', $${cols.length + 2}, $${cols.length + 2}) RETURNING *`,
      [req.params.id, ...cols.map((k) => v[k]), who(req)]);
    await audit.logChanges(c, { entityType: 'student_registration', entityId: r.registration_id, before: null, after: r, fields: [...cols, 'total_students'], changedBy: who(req) });
    return r;
  });
  res.status(201).json(row);
}));

// ---------------------------------------------------------------- teachers / contacts
router.get('/contacts', wrap(async (req, res) => {
  const { where, params } = schools.buildWhere(req.query);
  const { rows } = await db.query(
    `SELECT sc.*, s.school_name, s.state, s.district, s.city ${schools.BASE_FROM} JOIN school_contacts sc ON sc.school_id = s.school_id
     ${where} ORDER BY lower(s.school_name), sc.contact_type LIMIT 2000`, params);
  res.json(rows);
}));

// ---------------------------------------------------------------- channels & partners
function masterRoutes(table, idCol, fields) {
  router.get(`/${table}`, wrap(async (req, res) => res.json((await db.query(`SELECT * FROM ${table} ORDER BY lower(name)`)).rows)));
  router.post(`/${table}`, admin, wrap(async (req, res) => {
    const name = n.clean(req.body?.name); if (!name) throw bad('Name is required');
    const vals = fields.map((f) => (f === 'aliases' ? (req.body[f] || []).map(n.clean).filter(Boolean) : req.body[f] ?? null));
    try {
      const { rows: [r] } = await db.query(
        `INSERT INTO ${table} (name, ${fields.join(',')}) VALUES ($1, ${fields.map((_, i) => `$${i + 2}`).join(',')}) RETURNING *`, [name, ...vals]);
      await audit.logAction(db, { entityType: table, entityId: r[idCol], action: 'CREATE', note: name, changedBy: who(req) });
      res.status(201).json(r);
    } catch (e) { if (e.code === '23505') throw bad(`"${name}" already exists`, 409); throw e; }
  }));
  router.patch(`/${table}/:id`, admin, wrap(async (req, res) => {
    const allowed = ['name', 'is_active', ...fields];
    const cols = allowed.filter((f) => req.body && f in req.body);
    if (!cols.length) throw bad('Nothing to update');
    const vals = cols.map((f) => (f === 'name' ? n.clean(req.body.name) : f === 'aliases' ? (req.body.aliases || []).map(n.clean).filter(Boolean) : req.body[f]));
    if (cols.includes('name') && !vals[cols.indexOf('name')]) throw bad('Name is required');
    const { rows: [before] } = await db.query(`SELECT * FROM ${table} WHERE ${idCol}=$1`, [req.params.id]);
    if (!before) throw bad('Not found', 404);
    try {
      const { rows: [after] } = await db.query(
        `UPDATE ${table} SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(', ')}, updated_at=now() WHERE ${idCol}=$1 RETURNING *`, [req.params.id, ...vals]);
      await audit.logChanges(db, { entityType: table, entityId: req.params.id, before, after, fields: cols, changedBy: who(req) });
      res.json(after);
    } catch (e) { if (e.code === '23505') throw bad('That name already exists', 409); throw e; }
  }));
}
masterRoutes('channels', 'channel_id', ['description', 'aliases']);
masterRoutes('partners', 'partner_id', ['channel_id', 'description']);

// ---------------------------------------------------------------- users
const USER_FIELDS = ['name', 'email', 'team', 'role', 'access_role', 'state', 'city', 'status', 'aliases'];
function cleanUser(body, partial) {
  const out = {}; const errors = [];
  for (const f of USER_FIELDS) if (f in body) out[f] = f === 'aliases' ? (body.aliases || []).map(n.clean).filter(Boolean) : n.clean(body[f]);
  if (!partial && !out.name) errors.push('Name is required');
  if ('name' in out && !out.name) errors.push('Name is required');
  if (out.email) { const r = n.normEmail(out.email); if (r.error) errors.push(r.error); else out.email = r.value; }
  if (out.access_role && !['ADMIN', 'MANAGEMENT', 'NONE'].includes(out.access_role)) errors.push('access_role must be ADMIN, MANAGEMENT or NONE');
  if (out.status && !['ACTIVE', 'INACTIVE'].includes(out.status)) errors.push('status must be ACTIVE or INACTIVE');
  if (body.password) { if (String(body.password).length < 8) errors.push('Password must be at least 8 characters'); else out.password_hash = auth.hashPassword(String(body.password)); }
  if (errors.length) throw new ValidationError(errors);
  return out;
}
router.get('/users', wrap(async (req, res) => {
  const { rows } = await db.query(`SELECT user_id, name, email, team, role, access_role, state, city, status, aliases, created_via, is_demo,
    (password_hash IS NOT NULL) AS has_password, created_at, updated_at FROM users ORDER BY lower(name)`);
  res.json(rows);
}));
router.post('/users', admin, wrap(async (req, res) => {
  const v = cleanUser(req.body || {}, false);
  if (v.access_role && v.access_role !== 'NONE' && (!v.email || !v.password_hash)) throw bad('Users who can log in need an email and a password');
  const cols = Object.keys(v);
  try {
    const { rows: [u] } = await db.query(`INSERT INTO users (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING user_id, name, email, access_role`, cols.map((k) => v[k]));
    await audit.logAction(db, { entityType: 'user', entityId: u.user_id, action: 'CREATE', note: `${u.name} (${u.access_role})`, changedBy: who(req) });
    res.status(201).json(u);
  } catch (e) { if (e.code === '23505') throw bad('A user with that email already exists', 409); throw e; }
}));
router.patch('/users/:id', admin, wrap(async (req, res) => {
  const v = cleanUser(req.body || {}, true);
  const cols = Object.keys(v); if (!cols.length) throw bad('Nothing to update');
  const { rows: [before] } = await db.query('SELECT * FROM users WHERE user_id=$1', [req.params.id]);
  if (!before) throw bad('Not found', 404);
  if (Number(req.params.id) === req.user.user_id && (v.access_role && v.access_role !== 'ADMIN' || v.status === 'INACTIVE')) throw bad('You cannot remove your own admin access');
  try {
    const { rows: [after] } = await db.query(`UPDATE users SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(', ')}, updated_at=now() WHERE user_id=$1 RETURNING *`, [req.params.id, ...cols.map((k) => v[k])]);
    await audit.logChanges(db, { entityType: 'user', entityId: req.params.id, before, after, fields: cols.filter((c) => c !== 'password_hash'), changedBy: who(req) });
    if (v.password_hash || v.status === 'INACTIVE' || (v.access_role && v.access_role !== before.access_role)) await db.query('DELETE FROM sessions WHERE user_id=$1', [req.params.id]);
    res.json({ user_id: after.user_id, name: after.name, email: after.email, access_role: after.access_role, status: after.status });
  } catch (e) { if (e.code === '23505') throw bad('A user with that email already exists', 409); throw e; }
}));

// ---------------------------------------------------------------- integrations
const SOURCE_FIELDS = ['source_name', 'adapter', 'spreadsheet_id', 'sheet_name', 'source_type', 'status', 'sync_frequency_minutes',
  'header_row', 'date_format', 'column_mapping', 'row_filter', 'fixed_values', 'one_kit_per_school', 'writeback_enabled', 'student_mode', 'form_url'];
function cleanSource(body, partial) {
  const out = {};
  for (const f of SOURCE_FIELDS) if (f in body) out[f] = typeof body[f] === 'string' ? body[f].trim() : body[f];
  if (out.spreadsheet_id) { // accept a full Google Sheets URL
    const m = String(out.spreadsheet_id).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/); if (m) out.spreadsheet_id = m[1];
  }
  if (out.column_mapping) {
    if (typeof out.column_mapping === 'string') { try { out.column_mapping = JSON.parse(out.column_mapping || '{}'); } catch { throw bad('Column mapping must be valid JSON'); } }
    for (const v of Object.values(out.column_mapping)) if (v !== mapping.IGNORE && !mapping.CANONICAL_FIELDS.includes(v)) throw bad(`Unknown field "${v}" in column mapping`);
  }
  if (out.row_filter !== undefined) {
    if (typeof out.row_filter === 'string') { try { out.row_filter = JSON.parse(out.row_filter || '{}'); } catch { throw bad('Row filter must be valid JSON'); } }
    if (!out.row_filter || typeof out.row_filter !== 'object' || Array.isArray(out.row_filter)) throw bad('Row filter must be a JSON object like {"Type": "School"}');
  }
  if (out.one_kit_per_school !== undefined) {
    const v = { true: true, false: false, auto: null, '': null }[String(out.one_kit_per_school)];
    if (v === undefined && out.one_kit_per_school !== null) throw bad('Kit tab must be Yes, No or Auto');
    out.one_kit_per_school = v ?? null;
  }
  if (out.fixed_values !== undefined) {
    if (typeof out.fixed_values === 'string') { try { out.fixed_values = JSON.parse(out.fixed_values || '{}'); } catch { throw bad('Fixed values must be valid JSON'); } }
    if (!out.fixed_values || typeof out.fixed_values !== 'object' || Array.isArray(out.fixed_values)) throw bad('Fixed values must be a JSON object like {"channel": "Direct"}');
    const fv = {};
    for (const [k, v] of Object.entries(out.fixed_values)) {
      if (!mapping.FIXABLE_FIELDS.includes(k)) throw bad(`A fixed value can only be set for ${mapping.FIXABLE_FIELDS.join(', ')}`);
      if (String(v ?? '').trim()) fv[k] = String(v).trim();
    }
    out.fixed_values = fv;
  }
  if (!partial) for (const f of ['source_name', 'spreadsheet_id', 'sheet_name', 'source_type']) if (!out[f]) throw bad(`${f} is required`);
  return out;
}
const SOURCE_SELECT = `SELECT ds.*, (SELECT count(*)::int FROM duplicate_reviews r WHERE r.source_id=ds.source_id AND r.status='OPEN') AS open_reviews,
  (SELECT row_to_json(l) FROM (SELECT sync_id, status, started_at, finished_at, message, rows_read, rows_errored, rows_flagged FROM sync_logs WHERE source_id=ds.source_id ORDER BY sync_id DESC LIMIT 1) l) AS last_log
  FROM data_sources ds`;

router.get('/integration/status', wrap(async (req, res) => {
  const { rows } = await db.query(`SELECT count(*)::int AS sources, count(*) FILTER (WHERE status='ENABLED' AND connection_status='SYNC_ERROR')::int AS errors,
    max(last_successful_sync) AS last_successful_sync, (SELECT count(*)::int FROM duplicate_reviews WHERE status='OPEN') AS open_reviews
    FROM data_sources WHERE status='ENABLED'`);
  const r = rows[0];
  res.json({ ...r, overall: r.sources === 0 ? 'NOT_CONFIGURED' : r.errors ? 'SYNC_ERROR' : r.last_successful_sync ? 'CONNECTED' : 'NOT_SYNCED', google_credentials_configured: google.isConfigured() });
}));
router.get('/sources', wrap(async (req, res) => res.json((await db.query(`${SOURCE_SELECT} ORDER BY ds.source_id`)).rows)));
// two sources reading the same tab apply every row twice (and the later one's Channel/Partner wins)
async function assertTabNotTaken(v, id) {
  const { rows } = await db.query(`SELECT source_name, row_filter FROM data_sources WHERE spreadsheet_id=$1 AND lower(trim(sheet_name))=lower(trim($2))
    AND ($3::bigint IS NULL OR source_id <> $3)`, [v.spreadsheet_id, v.sheet_name, id || null]);
  const same = rows.find((r) => JSON.stringify(r.row_filter || {}) === JSON.stringify(v.row_filter || {}));
  if (same) throw bad(`Source "${same.source_name}" already reads the tab "${v.sheet_name}". Check the tab name.`);
}
router.post('/sources', admin, wrap(async (req, res) => {
  const v = cleanSource(req.body || {}, false);
  await assertTabNotTaken(v);
  const cols = Object.keys(v);
  const { rows: [s] } = await db.query(`INSERT INTO data_sources (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, cols.map((k) => v[k]));
  await audit.logAction(db, { entityType: 'data_source', entityId: s.source_id, action: 'CREATE', note: s.source_name, changedBy: who(req) });
  res.status(201).json(s);
}));
router.patch('/sources/:id', admin, wrap(async (req, res) => {
  const v = cleanSource(req.body || {}, true);
  const cols = Object.keys(v); if (!cols.length) throw bad('Nothing to update');
  const { rows: [before] } = await db.query('SELECT * FROM data_sources WHERE source_id=$1', [req.params.id]);
  if (!before) throw bad('Not found', 404);
  await assertTabNotTaken({ ...before, ...v }, before.source_id);
  const { rows: [after] } = await db.query(`UPDATE data_sources SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(', ')}, updated_at=now() WHERE source_id=$1 RETURNING *`, [req.params.id, ...cols.map((k) => v[k])]);
  await audit.logChanges(db, { entityType: 'data_source', entityId: req.params.id, before, after, fields: cols, changedBy: who(req) });
  res.json(after);
}));
router.post('/sources/:id/test', admin, wrap(async (req, res) => {
  const { rows: [s] } = await db.query('SELECT * FROM data_sources WHERE source_id=$1', [req.params.id]);
  if (!s) throw bad('Not found', 404);
  try {
    const adapter = adapterFor(s);
    const info = await adapter.testConnection(s);
    const sheet = await adapter.readSheet(s);
    const { rows } = await db.query('SELECT alias_norm, canonical_field FROM field_aliases');
    const m = mapping.buildMapping(sheet.headers, new Map(rows.map((r) => [r.alias_norm, r.canonical_field])), s.column_mapping);
    const keep = mapping.rowFilter(sheet.headers, s.row_filter);
    res.json({ ok: true, title: info.title, rows: sheet.rows.filter((r) => keep(r.values)).length, mapped: m.columns.map((c) => ({ header: c.header, field: c.field })), unmapped: m.unmapped });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
}));
router.post('/sources/:id/sync', admin, wrap(async (req, res) => res.json(await syncSource(Number(req.params.id), { triggeredBy: who(req) }))));
router.post('/sync-all', admin, wrap(async (req, res) => res.json(await syncAll({ triggeredBy: who(req) }))));
router.get('/sources/:id/logs', wrap(async (req, res) => {
  res.json((await db.query('SELECT * FROM sync_logs WHERE source_id=$1 ORDER BY sync_id DESC LIMIT 50', [req.params.id])).rows);
}));
router.get('/sync-logs/:id/issues', wrap(async (req, res) => {
  res.json((await db.query('SELECT * FROM sync_row_issues WHERE sync_id=$1 ORDER BY source_row, issue_id LIMIT 1000', [req.params.id])).rows);
}));

// ---------------------------------------------------------------- duplicate review
router.get('/reviews', wrap(async (req, res) => {
  const status = req.query.status || 'OPEN';
  const { rows } = await db.query(`SELECT r.*, ds.source_name, ds.source_type, ds.sheet_name FROM duplicate_reviews r LEFT JOIN data_sources ds USING (source_id)
    WHERE ($1 = 'ALL' OR r.status = $1) ORDER BY r.created_at DESC LIMIT 500`, [status]);
  res.json(rows);
}));
router.post('/reviews/:id/resolve', admin, wrap(async (req, res) => {
  res.json(await resolveReview(Number(req.params.id), req.body?.action, { schoolId: req.body?.school_id, user: req.user }));
}));

// ---------------------------------------------------------------- mapping aliases
router.get('/field-aliases', wrap(async (req, res) => {
  res.json({ fields: mapping.CANONICAL_FIELDS, aliases: (await db.query('SELECT * FROM field_aliases ORDER BY canonical_field, alias_norm')).rows });
}));
router.post('/field-aliases', admin, wrap(async (req, res) => {
  const alias = mapping.normHeader(req.body?.alias); const field = req.body?.canonical_field;
  if (!alias) throw bad('Alias is required');
  if (!mapping.CANONICAL_FIELDS.includes(field)) throw bad('Unknown canonical field');
  await db.query('INSERT INTO field_aliases (alias_norm, canonical_field) VALUES ($1,$2) ON CONFLICT (alias_norm) DO UPDATE SET canonical_field=EXCLUDED.canonical_field', [alias, field]);
  await audit.logAction(db, { entityType: 'field_alias', entityId: alias, action: 'UPDATE', note: field, changedBy: who(req) });
  res.status(201).json({ alias_norm: alias, canonical_field: field });
}));
router.delete('/field-aliases/:alias', admin, wrap(async (req, res) => {
  await db.query('DELETE FROM field_aliases WHERE alias_norm=$1', [req.params.alias]);
  await audit.logAction(db, { entityType: 'field_alias', entityId: req.params.alias, action: 'DELETE', changedBy: who(req) });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- geography (city -> district)
router.get('/geo', wrap(async (req, res) => res.json((await db.query('SELECT * FROM geo_city_district ORDER BY state, city')).rows)));
router.post('/geo', admin, wrap(async (req, res) => {
  const state = n.normState(req.body?.state); const city = n.normPlace(req.body?.city); const district = n.normPlace(req.body?.district);
  if (!state || !city || !district) throw bad('State, city and district are required');
  await db.query('INSERT INTO geo_city_district (state, city, district) VALUES ($1,$2,$3) ON CONFLICT (state, city) DO UPDATE SET district=EXCLUDED.district', [state, city, district]);
  await require('../services/geo').fillMissingPlaces(db, who(req)); // schools still missing a state
  // fill any school still missing a district (never overrides a manual or sheet district)
  const { rowCount } = await db.query(`UPDATE schools SET district=$3, district_origin='LOOKUP', updated_at=now(), updated_by=$4
     WHERE lower(state)=lower($1) AND lower(city)=lower($2) AND (district IS NULL OR district_origin='LOOKUP')`, [state, city, district, who(req)]);
  res.status(201).json({ state, city, district, schools_updated: rowCount });
}));

// ---------------------------------------------------------------- audit
router.get('/audit', admin, wrap(async (req, res) => {
  const { rows } = await db.query(`SELECT * FROM audit_logs WHERE ($1::text IS NULL OR entity_type=$1) AND ($2::text IS NULL OR change_source=$2)
    ORDER BY audit_id DESC LIMIT 300`, [req.query.entity_type || null, req.query.change_source || null]);
  res.json(rows);
}));

// ---------------------------------------------------------------- demo data
router.post('/demo/purge', admin, wrap(async (req, res) => {
  const out = await db.tx(async (c) => {
    const s = await c.query('DELETE FROM schools WHERE is_demo');
    await c.query('DELETE FROM data_sources WHERE is_demo');
    await c.query('DELETE FROM partners WHERE is_demo AND partner_id NOT IN (SELECT partner_id FROM schools WHERE partner_id IS NOT NULL)');
    await c.query('DELETE FROM channels WHERE is_demo AND channel_id NOT IN (SELECT channel_id FROM schools WHERE channel_id IS NOT NULL) AND channel_id NOT IN (SELECT channel_id FROM partners WHERE channel_id IS NOT NULL)');
    await c.query(`DELETE FROM users WHERE is_demo AND access_role='NONE' AND user_id NOT IN (SELECT sales_spoc_id FROM schools WHERE sales_spoc_id IS NOT NULL)`);
    await audit.logAction(c, { entityType: 'demo', entityId: 'all', action: 'DELETE', note: `${s.rowCount} demo schools removed`, changedBy: who(req) });
    return { schools_removed: s.rowCount };
  });
  res.json(out);
}));

// ---------------------------------------------------------------- errors
router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || (err instanceof ValidationError ? 400 : 500);
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message, errors: err.errors, candidates: err.candidates });
});

module.exports = router;
