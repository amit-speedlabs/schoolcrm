'use strict';
// Strict validation for manual (UI/API) edits. Throws a 400 with every problem listed.
const n = require('../util/normalize');

class ValidationError extends Error {
  constructor(errors) { super(errors.join('; ')); this.status = 400; this.errors = errors; }
}

// Returns a cleaned object containing only the provided (known) fields.
function validateSchool(input, { partial = false } = {}) {
  const out = {}; const errors = [];
  const has = (f) => Object.prototype.hasOwnProperty.call(input, f);
  if (!partial || has('school_name')) {
    const v = n.clean(input.school_name);
    if (!v) errors.push('School name is required'); else out.school_name = v;
  }
  for (const f of ['address', 'board', 'principal_name', 'coordinator_name']) if (has(f)) out[f] = n.clean(input[f]);
  for (const f of ['city', 'district']) if (has(f)) out[f] = n.normPlace(input[f]);
  if (has('state')) out.state = n.normState(input.state);
  for (const [f, label] of [['principal_contact', 'Principal contact'], ['coordinator_phone', 'Coordinator phone']]) {
    if (!has(f)) continue;
    const r = n.normPhone(input[f]); if (r.error) errors.push(`${label}: ${r.error}`); else out[f] = r.value;
  }
  if (has('school_email')) { const r = n.normEmail(input.school_email); if (r.error) errors.push(r.error); else out.school_email = r.value; }
  if (has('pin_code')) { const r = n.normPin(input.pin_code); if (r.error) errors.push(r.error); else out.pin_code = r.value; }
  for (const f of ['kit_drop_date', 'registration_date']) {
    if (!has(f)) continue;
    const r = n.parseDate(input[f], 'DMY'); if (r.error) errors.push(`${f}: ${r.error}`); else out[f] = r.value;
  }
  if (has('number_of_kits')) { const r = n.normCount(input.number_of_kits, 'number of kits'); if (r.error) errors.push(r.error); else out.number_of_kits = r.value; }
  for (const f of ['channel_id', 'partner_id', 'sales_spoc_id']) {
    if (!has(f)) continue;
    if (input[f] === null || input[f] === '') out[f] = null;
    else if (!Number.isInteger(Number(input[f]))) errors.push(`${f} must be an id`);
    else out[f] = Number(input[f]);
  }
  if (has('school_registered')) {
    if (typeof input.school_registered === 'boolean') out.school_registered = input.school_registered;
    else { const r = n.parseYesNo(input.school_registered); if (r.error || r.value === null) errors.push('school_registered must be YES or NO'); else out.school_registered = r.value; }
  }
  if (errors.length) throw new ValidationError(errors);
  return out;
}

const GRADES = [3, 4, 5, 6, 7, 8, 9, 10];
function validateStudentRegistration(input) {
  const out = {}; const errors = [];
  for (const g of GRADES) {
    const f = `grade_${g}_count`;
    const raw = input[f] === undefined || input[f] === null || input[f] === '' ? '0' : String(input[f]);
    const r = n.normCount(raw, `Grade ${g} count`);
    if (r.error) errors.push(r.error); else out[f] = r.value;
  }
  if (input.registration_date) {
    const r = n.parseDate(input.registration_date); if (r.error) errors.push(r.error); else out.registration_date = r.value;
  } else out.registration_date = null;
  if (errors.length) throw new ValidationError(errors);
  return out;
}

module.exports = { validateSchool, validateStudentRegistration, ValidationError };
