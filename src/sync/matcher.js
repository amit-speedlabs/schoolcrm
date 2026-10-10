'use strict';
// Secondary school matching when a row carries no School ID.
// Signals (spec §14): school name, city, principal contact, school email, PIN code.
const n = require('../util/normalize');

const AUTO_LINK_SCORE = 70;
const REVIEW_SCORE = 40;

function scoreCandidate(inc, s) {
  const reasons = [];
  let score = 0;
  const sim = n.nameSimilarity(inc.school_name, s.school_name);
  if (sim === 1) { score += 50; reasons.push('Same name'); }
  else if (sim >= 0.85) { score += 35; reasons.push(`Similar name (${Math.round(sim * 100)}%)`); }
  else if (sim >= 0.7) { score += 20; reasons.push(`Partly similar name (${Math.round(sim * 100)}%)`); }

  const ic = n.normPlace(inc.city); const sc = n.normPlace(s.city);
  if (ic && sc) {
    if (ic === sc) { score += 20; reasons.push('Same city'); }
    else score -= 30; // same-name schools in different cities are usually different branches
  } else if (inc.state && s.state && n.normState(inc.state) !== n.normState(s.state)) {
    score -= 30; // no city to compare: a different state means a different branch (Sri Chaitanya Madurai vs Patan)
  }
  if (inc.principal_contact && inc.principal_contact === s.principal_contact) { score += 40; reasons.push('Same principal contact'); }
  if (inc.school_email && inc.school_email === s.school_email) { score += 40; reasons.push('Same school email'); }
  if (inc.coordinator_phone && inc.coordinator_phone === s.coordinator_phone) { score += 25; reasons.push('Same coordinator phone'); }
  let pinConflict = false;
  if (inc.pin_code && s.pin_code) {
    if (inc.pin_code === s.pin_code) { score += 10; reasons.push('Same PIN code'); } else pinConflict = true;
  }
  return { school_id: s.school_id, school_name: s.school_name, city: s.city, state: s.state, score, sim, reasons, pinConflict };
}

/**
 * inc: normalised incoming record { school_name, city, principal_contact, school_email, coordinator_phone, pin_code }
 * schools: array of existing schools (same shape + school_id)
 * returns { decision: 'MATCH'|'REVIEW'|'NONE', school_id?, candidates[] }
 */
function match(inc, schools, { exclude } = {}) {
  const cands = [];
  for (const s of schools) {
    const c = scoreCandidate(inc, s);
    if (c.score >= REVIEW_SCORE) cands.push(c);
  }
  cands.sort((a, b) => b.score - a.score);
  const top = cands.slice(0, 5);
  if (!top.length) return { decision: 'NONE', candidates: [] };
  const best = top[0];
  const second = top[1];
  const unique = !second || second.score < AUTO_LINK_SCORE;
  if (best.score >= AUTO_LINK_SCORE && best.sim >= 0.85 && unique && !best.pinConflict && !(exclude && exclude(best.school_id))) {
    return { decision: 'MATCH', school_id: best.school_id, candidates: top };
  }
  return { decision: 'REVIEW', candidates: top };
}

module.exports = { match, scoreCandidate, AUTO_LINK_SCORE, REVIEW_SCORE };
