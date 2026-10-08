'use strict';
// Value normalisation + validation shared by the sync engine and manual edits.

const STATE_ALIASES = {
  mh: 'Maharashtra', maharastra: 'Maharashtra', gj: 'Gujarat', up: 'Uttar Pradesh', 'u p': 'Uttar Pradesh',
  ka: 'Karnataka', dl: 'Delhi', 'nct of delhi': 'Delhi', 'new delhi': 'Delhi', rj: 'Rajasthan', mp: 'Madhya Pradesh',
  tn: 'Tamil Nadu', ts: 'Telangana', tg: 'Telangana', wb: 'West Bengal', kl: 'Kerala', hr: 'Haryana', pb: 'Punjab',
  br: 'Bihar', or: 'Odisha', orissa: 'Odisha', ga: 'Goa', ap: 'Andhra Pradesh', uk: 'Uttarakhand', uttaranchal: 'Uttarakhand',
  jh: 'Jharkhand', cg: 'Chhattisgarh', hp: 'Himachal Pradesh', as: 'Assam', jk: 'Jammu and Kashmir',
};

function clean(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

const SMALL = new Set(['of', 'and', 'the', 'in', 'on', 'at', 'for']);
function titleCase(s) {
  s = clean(s);
  if (!s) return null;
  return s.toLowerCase().split(' ').map((w, i) =>
    (i > 0 && SMALL.has(w)) ? w : w.replace(/(^|[-(/])([a-z])/g, (m, p, c) => p + c.toUpperCase())
  ).join(' ');
}

function normState(s) {
  s = clean(s);
  if (!s) return null;
  const k = s.toLowerCase().replace(/[.]/g, '').trim();
  return STATE_ALIASES[k] || titleCase(s);
}

function normPlace(s) { return titleCase(s); }

// For matching only: lower-case, "&"->and, strip punctuation and the word "the"
function nameKey(s) {
  s = clean(s);
  if (!s) return '';
  return s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
    .split(' ').filter((w) => w && w !== 'the').join(' ');
}

// Sørensen–Dice coefficient on character bigrams (0..1)
function similarity(a, b) {
  a = nameKey(a).replace(/ /g, ''); b = nameKey(b).replace(/ /g, '');
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); grams.set(g, (grams.get(g) || 0) + 1); }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2); const n = grams.get(g);
    if (n) { hit++; grams.set(g, n - 1); }
  }
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

// Words most school names share; they say little about which school it is.
const GENERIC_NAME_WORDS = new Set(['school', 'schools', 'sch', 'international', 'intl', 'english', 'medium', 'public', 'high', 'higher',
  'highschool', 'senior', 'sr', 'secondary', 'sec', 'primary', 'convent', 'academy', 'cbse', 'icse', 'of', 'and',
  'shree', 'shri', 'sri', 'vidyalaya', 'vidyalay', 'vidhyalaya', 'vidhyalay']);
// a misspelt generic word ("Intetnational") is still generic
const isGeneric = (w) => GENERIC_NAME_WORDS.has(w) || (w.length >= 7 && [...GENERIC_NAME_WORDS].some((g) => g.length >= 7 && similarity(w, g) >= 0.8));
function coreWords(s) {
  // initials written with dots or spaces ("R.K.G", "R D") form one word: "rkg", "rd"
  const words = nameKey(s).replace(/\b([a-z]) (?=[a-z]\b)/g, '$1').split(' ');
  return words.filter((w) => w && !isGeneric(w));
}
function coreName(s) { return coreWords(s).join(' '); }
// Name similarity for matching schools: compares the distinctive words, so "Krishna International School" is not
// close to "Amity International School". Equal distinctive words with different full names count as similar, not same.
// Names that share few distinctive words are capped, so "Ancheli Highschool" is not close to "Sitanjali Highschool"
// and "P N Patel" is not close to "R D Patel".
function nameSimilarity(a, b) {
  const full = similarity(a, b);
  const wa = coreWords(a); const wb = coreWords(b);
  if (!wa.length || !wb.length || full === 1) return full;
  const core = similarity(wa.join(' '), wb.join(' '));
  if (core === 1) return Math.max(Math.min(full, 0.99), 0.9);
  const near = (w, list) => list.some((x) => x === w || (w.length >= 5 && x.length >= 5 && similarity(w, x) >= 0.8));
  const shared = wa.filter((w) => near(w, wb)).length;
  const ratio = shared / Math.max(wa.length, wb.length);
  return Math.min(core, 0.5 + ratio / 2);
}

// Phones: keep digits, drop +91 / leading 0. Valid = 10-digit mobile or 10-11 digit landline.
function normPhone(v) {
  v = clean(v);
  if (!v) return { value: null };
  let d = v.replace(/\.0$/, '').replace(/[^0-9]/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) return { value: d };
  return { value: null, error: `Invalid phone "${v}"` };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function normEmail(v) {
  v = clean(v);
  if (!v) return { value: null };
  const e = v.toLowerCase();
  return EMAIL_RE.test(e) ? { value: e } : { value: null, error: `Invalid email "${v}"` };
}

function normPin(v) {
  v = clean(v);
  if (!v) return { value: null };
  const d = v.replace(/\.0$/, '').replace(/\s+/g, '');
  return /^[1-9][0-9]{5}$/.test(d) ? { value: d } : { value: null, error: `Invalid PIN code "${v}"` };
}

function normCount(v, label = 'count') {
  v = clean(v);
  if (!v) return { value: null };
  const s = v.replace(/,/g, '');
  if (!/^-?\d+(\.0+)?$/.test(s)) return { value: null, error: `Invalid ${label} "${v}" (must be a whole number)` };
  const n = parseInt(s, 10);
  if (n < 0) return { value: null, error: `Invalid ${label} "${v}" (cannot be negative)` };
  if (n > 100000) return { value: null, error: `Invalid ${label} "${v}" (implausibly large)` };
  return { value: n };
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function pad(n) { return String(n).padStart(2, '0'); }
function validYmd(y, m, d) {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 2000 || y > 2100) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

// Parses sheet dates into 'YYYY-MM-DD'. Handles ISO, D/M/Y (or M/D/Y per source),
// "20 Sept 2026", "20-Sep-2026", Google Forms timestamps and Sheets serial numbers.
function parseDate(v, order = 'DMY') {
  v = clean(v);
  if (!v) return { value: null };
  v = v.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+/i, ''); // "Wednesday, October 1, 2026"
  let m;
  if ((m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    const r = validYmd(+m[1], +m[2], +m[3]); if (r) return { value: r };
  } else if ((m = v.match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})(\s|$|,)/))) {
    const [a, b, c] = [+m[1], +m[2], +m[3]];
    let r = null;
    if (m[1].length === 4) r = validYmd(a, b, c);
    else if (order === 'MDY') r = validYmd(c, a, b);
    else r = validYmd(c, b, a);
    if (r) return { value: r };
  } else if ((m = v.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})[,\s-]+(\d{2,4})$/))) {
    const mo = MONTHS[m[2].toLowerCase().slice(0, 4)] || MONTHS[m[2].toLowerCase().slice(0, 3)];
    if (mo) { const r = validYmd(+m[3], mo, +m[1]); if (r) return { value: r }; }
  } else if ((m = v.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, 4)] || MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (mo) { const r = validYmd(+m[3], mo, +m[2]); if (r) return { value: r }; }
  } else if ((m = v.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?$/)) || (m = v.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})$/))) {
    // day and month without a year (e.g. "28 Sep"): assume the current year in India
    const [day, mon] = /^\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
    const mo = MONTHS[mon.toLowerCase().slice(0, 4)] || MONTHS[mon.toLowerCase().slice(0, 3)];
    const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(new Date()));
    if (mo) { const r = validYmd(year, mo, +day); if (r) return { value: r }; }
  } else if (/^\d{5}(\.\d+)?$/.test(v)) {
    // Google Sheets serial date (days since 1899-12-30)
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(v)) * 86400000);
    const r = validYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    if (r) return { value: r };
  }
  return { value: null, error: `Invalid date "${v}"` };
}

function parseYesNo(v) {
  v = clean(v);
  if (!v) return { value: null };
  const s = v.toLowerCase();
  if (['yes', 'y', 'true', '1', 'registered', 'done', 'completed'].includes(s)) return { value: true };
  if (['no', 'n', 'false', '0', 'not registered', 'pending'].includes(s)) return { value: false };
  return { value: null, error: `Unrecognised yes/no value "${v}"` };
}

module.exports = {
  clean, titleCase, normState, normPlace, nameKey, similarity, coreName, nameSimilarity,
  normPhone, normEmail, normPin, normCount, parseDate, parseYesNo,
};
