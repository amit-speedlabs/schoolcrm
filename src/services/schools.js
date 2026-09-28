'use strict';
// Filtered school queries shared by the school list, dashboard metrics, drill-downs and exports.
// Every KPI / table / chart / export goes through buildWhere(), so they always agree.
const db = require('../db');

const NONE = '__none__';

const BASE_FROM = `
  FROM schools s
  LEFT JOIN school_student_totals t ON t.school_id = s.school_id
  LEFT JOIN channels c ON c.channel_id = s.channel_id
  LEFT JOIN partners p ON p.partner_id = s.partner_id
  LEFT JOIN users u ON u.user_id = s.sales_spoc_id`;

const list = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : String(v).split(','))
  .map((x) => String(x).trim()).filter(Boolean);

function buildWhere(f = {}) {
  const where = []; const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };

  const textIn = (col, values) => {
    const vals = list(values); if (!vals.length) return;
    const real = vals.filter((v) => v !== NONE);
    const parts = [];
    if (real.length) parts.push(`lower(${col}) = ANY(${p(real.map((v) => v.toLowerCase()))})`);
    if (vals.includes(NONE)) parts.push(`(${col} IS NULL OR ${col} = '')`);
    where.push(`(${parts.join(' OR ')})`);
  };
  const idIn = (col, values) => {
    const vals = list(values); if (!vals.length) return;
    const ids = vals.filter((v) => v !== NONE).map(Number).filter(Number.isInteger);
    const parts = [];
    if (ids.length) parts.push(`${col} = ANY(${p(ids)})`);
    if (vals.includes(NONE)) parts.push(`${col} IS NULL`);
    if (parts.length) where.push(`(${parts.join(' OR ')})`);
  };

  textIn('s.state', f.state);
  textIn('s.district', f.district);
  textIn('s.city', f.city);
  textIn('s.board', f.board);
  idIn('s.channel_id', f.channel);
  idIn('s.partner_id', f.partner);
  idIn('s.sales_spoc_id', f.spoc);
  if (f.kit === 'yes') where.push('s.kit_given');
  if (f.kit === 'no') where.push('NOT s.kit_given');
  if (f.registered === 'yes') where.push('s.school_registered');
  if (f.registered === 'no') where.push('NOT s.school_registered');
  if (f.students === 'yes') where.push('coalesce(t.total_students,0) > 0');
  if (f.students === 'no') where.push('coalesce(t.total_students,0) = 0');
  if (f.demo === 'only') where.push('s.is_demo');
  if (f.demo === 'exclude') where.push('NOT s.is_demo');

  const dateCol = { kit: 's.kit_drop_date', registration: 's.registration_date', student: 't.first_student_registration_date' }[f.date_field || 'kit'] || 's.kit_drop_date';
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
  if (isDate(f.date_from)) where.push(`${dateCol} >= ${p(f.date_from)}::date`);
  if (isDate(f.date_to)) where.push(`${dateCol} <= ${p(f.date_to)}::date`);

  if (f.q && String(f.q).trim()) {
    const term = `%${String(f.q).trim().toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const digits = String(f.q).replace(/[^0-9]/g, '');
    const ph = p(term);
    const conds = ['s.school_name', 's.school_id', 's.city', 's.principal_name', 's.coordinator_name', 's.school_email', 's.principal_contact', 's.coordinator_phone']
      .map((c) => `lower(${c}) LIKE ${ph}`);
    if (digits.length >= 4) {
      const dp = p(`%${digits}%`);
      conds.push(`s.principal_contact LIKE ${dp}`, `s.coordinator_phone LIKE ${dp}`);
    }
    where.push(`(${conds.join(' OR ')})`);
  }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const SCHOOL_COLUMNS = `
  s.school_id, s.school_name, s.state, s.district, s.city, s.address, s.pin_code, s.board,
  s.principal_name, s.principal_contact, s.school_email, s.coordinator_name, s.coordinator_phone,
  s.channel_id, c.name AS channel, s.partner_id, p.name AS partner, s.sales_spoc_id, u.name AS sales_spoc,
  s.kit_given, s.kit_drop_date, s.number_of_kits, s.school_registered, s.registration_date,
  coalesce(t.grade_3,0) AS grade_3, coalesce(t.grade_4,0) AS grade_4, coalesce(t.grade_5,0) AS grade_5,
  coalesce(t.grade_6,0) AS grade_6, coalesce(t.grade_7,0) AS grade_7, coalesce(t.grade_8,0) AS grade_8,
  coalesce(t.grade_9,0) AS grade_9, coalesce(t.grade_10,0) AS grade_10, coalesce(t.ungraded,0) AS ungraded, coalesce(t.total_students,0) AS total_students,
  s.source, s.source_sheet, s.source_row, s.last_synced_at, s.is_demo, s.updated_at`;

const SORTABLE = {
  school_id: 's.school_id', school_name: 'lower(s.school_name)', state: 'lower(s.state)', district: 'lower(s.district)',
  city: 'lower(s.city)', board: 's.board', channel: 'lower(c.name)', partner: 'lower(p.name)', sales_spoc: 'lower(u.name)',
  kit_given: 's.kit_given', kit_drop_date: 's.kit_drop_date', number_of_kits: 's.number_of_kits',
  school_registered: 's.school_registered', registration_date: 's.registration_date', total_students: 'coalesce(t.total_students,0)',
  principal_name: 'lower(s.principal_name)', coordinator_name: 'lower(s.coordinator_name)', updated_at: 's.updated_at',
};
for (const g of [3, 4, 5, 6, 7, 8, 9, 10]) SORTABLE[`grade_${g}`] = `coalesce(t.grade_${g},0)`;
SORTABLE.ungraded = 'coalesce(t.ungraded,0)';

async function listSchools(f = {}, { page = 1, pageSize = 25, sort = 'school_id', dir = 'asc', all = false } = {}) {
  const { where, params } = buildWhere(f);
  const order = `${SORTABLE[sort] || 's.school_id'} ${dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, s.school_id ASC`;
  pageSize = Math.min(Math.max(Number(pageSize) || 25, 1), 500);
  page = Math.max(Number(page) || 1, 1);
  const limit = all ? '' : `LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
  const [rows, count] = await Promise.all([
    db.query(`SELECT ${SCHOOL_COLUMNS} ${BASE_FROM} ${where} ORDER BY ${order} ${limit}`, params),
    all ? null : db.query(`SELECT count(*)::int AS n ${BASE_FROM} ${where}`, params),
  ]);
  return { rows: rows.rows, total: all ? rows.rows.length : count.rows[0].n, page, pageSize };
}

const AGG = `
  count(*)::int AS schools,
  count(*) FILTER (WHERE s.kit_given)::int AS kits_distributed,
  coalesce(sum(s.number_of_kits) FILTER (WHERE s.kit_given),0)::int AS total_kits,
  count(*) FILTER (WHERE s.school_registered)::int AS registered_schools,
  count(*) FILTER (WHERE s.school_registered AND s.kit_given)::int AS registered_with_kit,
  count(*) FILTER (WHERE coalesce(t.total_students,0) > 0)::int AS schools_with_students,
  coalesce(sum(t.total_students),0)::int AS students,
  coalesce(sum(t.grade_3),0)::int AS grade_3, coalesce(sum(t.grade_4),0)::int AS grade_4,
  coalesce(sum(t.grade_5),0)::int AS grade_5, coalesce(sum(t.grade_6),0)::int AS grade_6,
  coalesce(sum(t.grade_7),0)::int AS grade_7, coalesce(sum(t.grade_8),0)::int AS grade_8,
  coalesce(sum(t.grade_9),0)::int AS grade_9, coalesce(sum(t.grade_10),0)::int AS grade_10,
  coalesce(sum(t.ungraded),0)::int AS ungraded`;

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
function derive(r) {
  return {
    ...r,
    kit_coverage_pct: pct(r.kits_distributed, r.schools),
    registration_pct: pct(r.registered_schools, r.schools),
    kit_to_registration_pct: pct(r.registered_with_kit, r.kits_distributed),
    avg_students_per_registered_school: r.registered_schools ? Math.round((r.students / r.registered_schools) * 10) / 10 : 0,
  };
}

async function metrics(f = {}) {
  const { where, params } = buildWhere(f);
  const { rows } = await db.query(`SELECT ${AGG} ${BASE_FROM} ${where}`, params);
  return derive(rows[0]);
}

// Group-by dimensions for drill-downs. key = value used for filtering the next level.
const DIMENSIONS = {
  state: { select: `s.state AS label, s.state AS key`, group: 's.state' },
  district: { select: `s.district AS label, s.district AS key, s.state AS parent`, group: 's.state, s.district' },
  city: { select: `s.city AS label, s.city AS key, s.district AS parent, s.state AS grandparent`, group: 's.state, s.district, s.city' },
  channel: { select: `c.name AS label, s.channel_id::text AS key`, group: 'c.name, s.channel_id' },
  partner: { select: `p.name AS label, s.partner_id::text AS key, c.name AS parent`, group: 'c.name, p.name, s.partner_id' },
  spoc: { select: `u.name AS label, s.sales_spoc_id::text AS key`, group: 'u.name, s.sales_spoc_id' },
  board: { select: `s.board AS label, s.board AS key`, group: 's.board' },
};
const BREAKDOWN_SORT = ['label', 'schools', 'kits_distributed', 'total_kits', 'registered_schools', 'students',
  'kit_coverage_pct', 'registration_pct', 'kit_to_registration_pct', 'avg_students_per_registered_school'];

async function breakdown(dimension, f = {}, { sort = 'schools', dir = 'desc' } = {}) {
  const d = DIMENSIONS[dimension];
  if (!d) throw Object.assign(new Error(`Unknown dimension ${dimension}`), { status: 400 });
  const { where, params } = buildWhere(f);
  const { rows } = await db.query(`SELECT ${d.select}, ${AGG} ${BASE_FROM} ${where} GROUP BY ${d.group}`, params);
  const out = rows.map((r) => derive({ ...r, key: r.key ?? NONE, label: r.label ?? 'Not set' }));
  const k = BREAKDOWN_SORT.includes(sort) ? sort : 'schools';
  const m = dir === 'asc' ? 1 : -1;
  out.sort((a, b) => {
    const x = a[k]; const y = b[k];
    if (k === 'label') return m * String(x).localeCompare(String(y));
    return m * (x - y) || String(a.label).localeCompare(String(b.label));
  });
  return out;
}

async function getSchool(id) {
  const { rows } = await db.query(
    `SELECT ${SCHOOL_COLUMNS}, s.district_origin, s.channel_raw, s.sales_spoc_raw, s.registration_source, s.registration_form,
            s.last_registration_sync, s.created_at, s.created_by, s.updated_by, s.source_id, ds.source_name, t.last_student_sync
     ${BASE_FROM} LEFT JOIN data_sources ds ON ds.source_id = s.source_id WHERE s.school_id = $1`, [id]);
  if (!rows[0]) return null;
  const school = rows[0];
  const [contacts, students, audit, lineage] = await Promise.all([
    db.query('SELECT * FROM school_contacts WHERE school_id=$1 ORDER BY contact_type, contact_id', [id]),
    db.query(`SELECT sr.*, ds.source_name FROM student_registrations sr LEFT JOIN data_sources ds USING (source_id)
              WHERE school_id=$1 ORDER BY is_superseded, registration_date DESC NULLS LAST, registration_id DESC`, [id]),
    db.query(`SELECT * FROM audit_logs WHERE (entity_type='school' AND entity_id=$1)
              OR (entity_type='student_registration' AND entity_id IN (SELECT registration_id::text FROM student_registrations WHERE school_id=$1))
              ORDER BY changed_at DESC, audit_id DESC LIMIT 100`, [id]),
    db.query(`SELECT sr.source_id, ds.source_name, ds.source_type, ds.sheet_name, sr.source_row, sr.last_seen_at
              FROM source_rows sr JOIN data_sources ds USING (source_id) WHERE sr.school_id=$1 ORDER BY ds.source_type, sr.source_row`, [id]),
  ]);
  return { ...school, contacts: contacts.rows, student_registrations: students.rows, audit: audit.rows, source_links: lineage.rows };
}

module.exports = { buildWhere, listSchools, metrics, breakdown, getSchool, DIMENSIONS, BASE_FROM, NONE };
