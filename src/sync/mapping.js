'use strict';
// Header -> canonical field mapping layer.
// Resolution order per column: per-source override -> global alias table -> grade pattern.

const SCHOOL_FIELDS = [
  'school_id', 'school_name', 'city', 'district', 'address', 'pin_code', 'state', 'board',
  'principal_name', 'principal_contact', 'school_email', 'coordinator_name', 'coordinator_phone',
  'coordinator_address', 'kit_drop_date', 'number_of_kits', 'channel', 'partner', 'sales_spoc',
];
const GRADES = [3, 4, 5, 6, 7, 8, 9, 10];
const GRADE_FIELDS = GRADES.map((g) => `grade_${g}_count`);
const REGISTRATION_FIELDS = ['registration_date', 'school_registered'];
const CANONICAL_FIELDS = [...SCHOOL_FIELDS, ...REGISTRATION_FIELDS, ...GRADE_FIELDS, 'total_students'];
const IGNORE = '__ignore__';

function normHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const ROMAN = { iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const WORDS = { three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
// "Grade 3", "Class III", "Std 10 students", "No. of students in Grade 7", "3rd grade", "Grade-3 Count"
function gradeFromHeader(norm) {
  let m = norm.match(/\b(?:grade|class|std|standard)\s*(\d{1,2}|iii|iv|v|vi|vii|viii|ix|x|three|four|five|six|seven|eight|nine|ten)\b/);
  if (!m) m = norm.match(/\b(\d{1,2})(?:st|nd|rd|th)\s*(?:grade|class|std|standard)\b/);
  if (!m) return null;
  const token = m[1];
  const g = /^\d+$/.test(token) ? Number(token) : (ROMAN[token] || WORDS[token]);
  return GRADES.includes(g) ? `grade_${g}_count` : null;
}

/**
 * @param headers   array of raw sheet headers
 * @param aliases   Map(alias_norm -> canonical_field)
 * @param overrides object { "Raw Header" | "normalised header": canonical_field | "__ignore__" }
 * @returns { columns: [{index, header, field}], byField: {field: index}, unmapped: [header] }
 */
function buildMapping(headers, aliases, overrides = {}) {
  const ov = {};
  for (const [k, v] of Object.entries(overrides || {})) ov[normHeader(k)] = v;
  const columns = []; const byField = {}; const unmapped = [];
  headers.forEach((header, index) => {
    const n = normHeader(header);
    if (!n) return;
    let field = ov[n] || aliases.get(n) || gradeFromHeader(n) || null;
    if (field === IGNORE) return;
    if (field && !CANONICAL_FIELDS.includes(field)) field = null;
    if (!field) { unmapped.push(header); return; }
    if (byField[field] !== undefined) { unmapped.push(`${header} (duplicate of ${field})`); return; }
    byField[field] = index;
    columns.push({ index, header, field });
  });
  return { columns, byField, unmapped };
}

// Per-source row filter, e.g. {"Type": "School"} or {"Type": ["School", "Schools"]}.
// Returns a predicate over a row's values; values compare trimmed and case-insensitively.
function rowFilter(headers, filter) {
  const conds = Object.entries(filter || {}).map(([header, want]) => {
    const index = headers.findIndex((h) => normHeader(h) === normHeader(header));
    if (index < 0) throw new Error(`Row filter column "${header}" not found. Headers found: ${headers.join(', ')}`);
    const allowed = (Array.isArray(want) ? want : [want]).map((v) => String(v).trim().toLowerCase());
    return { index, allowed };
  });
  return (values) => conds.every((c) => allowed(c, values));
}
const allowed = (c, values) => c.allowed.includes(String(values[c.index] ?? '').trim().toLowerCase());

function extract(mapping, values) {
  const rec = {};
  for (const c of mapping.columns) rec[c.field] = values[c.index] === undefined ? '' : String(values[c.index]);
  return rec;
}

module.exports = {
  SCHOOL_FIELDS, GRADE_FIELDS, GRADES, REGISTRATION_FIELDS, CANONICAL_FIELDS, IGNORE,
  normHeader, gradeFromHeader, buildMapping, rowFilter, extract,
};
