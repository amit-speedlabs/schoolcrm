'use strict';
// Fills a school's missing State (and City / District when possible) from what the CRM already has:
// the City, a state or city name written in the Address, or the PIN code.
const n = require('../util/normalize');

const STATES = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
  'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand',
  'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
  'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry'];
// extra spellings seen in addresses
const STATE_WORDS = { maharastra: 'Maharashtra', orissa: 'Odisha', 'tamilnadu': 'Tamil Nadu', 'uttaranchal': 'Uttarakhand', 'pondicherry': 'Puducherry' };

// PIN code prefixes that belong to a single state (3-digit prefixes checked first).
const PIN3 = { 403: 'Goa', 160: 'Chandigarh', 744: 'Andaman and Nicobar Islands', 737: 'Sikkim' };
const PIN2 = {
  11: 'Delhi', 12: 'Haryana', 13: 'Haryana', 14: 'Punjab', 15: 'Punjab', 17: 'Himachal Pradesh', 19: 'Jammu and Kashmir',
  20: 'Uttar Pradesh', 21: 'Uttar Pradesh', 22: 'Uttar Pradesh', 23: 'Uttar Pradesh', 27: 'Uttar Pradesh', 28: 'Uttar Pradesh',
  30: 'Rajasthan', 31: 'Rajasthan', 32: 'Rajasthan', 33: 'Rajasthan', 34: 'Rajasthan',
  36: 'Gujarat', 37: 'Gujarat', 38: 'Gujarat', 39: 'Gujarat',
  40: 'Maharashtra', 41: 'Maharashtra', 42: 'Maharashtra', 43: 'Maharashtra', 44: 'Maharashtra',
  45: 'Madhya Pradesh', 46: 'Madhya Pradesh', 47: 'Madhya Pradesh', 48: 'Madhya Pradesh', 49: 'Chhattisgarh',
  50: 'Telangana', 51: 'Andhra Pradesh', 52: 'Andhra Pradesh', 53: 'Andhra Pradesh',
  56: 'Karnataka', 57: 'Karnataka', 58: 'Karnataka', 59: 'Karnataka',
  60: 'Tamil Nadu', 61: 'Tamil Nadu', 62: 'Tamil Nadu', 63: 'Tamil Nadu', 64: 'Tamil Nadu',
  67: 'Kerala', 68: 'Kerala', 69: 'Kerala', 70: 'West Bengal', 71: 'West Bengal', 72: 'West Bengal', 73: 'West Bengal', 74: 'West Bengal',
  75: 'Odisha', 76: 'Odisha', 77: 'Odisha', 78: 'Assam', 80: 'Bihar', 84: 'Bihar', 85: 'Bihar',
};

const TAIL_WORDS = new Set(['india', 'dist', 'district', 'pin', 'pincode', 'code', 'city', 'taluka', 'tal', 'west', 'east', 'north', 'south']);
const words = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const one = (set) => (set.size === 1 ? [...set][0] : null);

function stateFromPin(pin) {
  const p = String(pin || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(p)) return null;
  return PIN3[p.slice(0, 3)] || PIN2[p.slice(0, 2)] || null;
}

/** geo: rows of geo_city_district. Returns { state, city } (either may be null). */
function inferPlace(school, geo) {
  const statesOfCity = (c) => new Set(geo.filter((g) => g.city.toLowerCase() === c.toLowerCase()).map((g) => g.state));
  if (school.city) {
    const st = one(statesOfCity(school.city));
    if (st) return { state: st, city: null };
  }
  const addr = words(school.address);
  if (addr.trim()) {
    const named = new Set(STATES.filter((st) => addr.includes(words(st))));
    for (const [w, st] of Object.entries(STATE_WORDS)) if (addr.includes(` ${w} `)) named.add(st);
    if (one(named)) return { state: one(named), city: null };
  }
  // a PIN code is more reliable than a city name found in free text ("Sagar", "Anand" are also common words)
  const pin = school.pin_code || (String(school.address || '').match(/\b(\d{3}\s?\d{3})\b/) || [])[1];
  const pinState = stateFromPin(pin);
  if (pinState) return { state: pinState, city: null };
  if (addr.trim()) {
    // Indian addresses end with the town: use a city name only when little but a PIN / district follows it,
    // so "Sagar Colony, Main Road" does not count as the town Sagar
    const hits = geo.filter((g) => {
      const at = addr.lastIndexOf(words(g.city));
      if (at < 0) return false;
      const rest = addr.slice(at + words(g.city).length).split(' ').filter((w) => w && !/^\d+$/.test(w) && !TAIL_WORDS.has(w));
      return rest.length === 0;
    });
    const st = one(new Set(hits.map((g) => g.state)));
    if (st) return { state: st, city: school.city ? null : one(new Set(hits.map((g) => g.city))) };
  }
  return { state: null, city: null };
}

// Sweep: fill State (and City, District) on schools that have no state yet. Never overwrites a value.
async function fillMissingPlaces(db, who = 'SYSTEM') {
  const { rows: geo } = await db.query('SELECT state, city, district FROM geo_city_district');
  const { rows } = await db.query(`SELECT school_id, city, address, pin_code FROM schools WHERE state IS NULL OR state = ''`);
  let filled = 0;
  for (const s of rows) {
    const p = inferPlace(s, geo);
    if (!p.state) continue;
    await db.query(`UPDATE schools SET state=$2, city=coalesce(nullif(city,''), $3), updated_at=now(), updated_by=$4 WHERE school_id=$1`,
      [s.school_id, p.state, p.city ? n.normPlace(p.city) : null, who]);
    filled++;
  }
  if (filled) {
    await db.query(`UPDATE schools s SET district=g.district, district_origin='LOOKUP', updated_at=now()
      FROM geo_city_district g WHERE s.district IS NULL AND lower(s.state)=lower(g.state) AND lower(s.city)=lower(g.city)`);
  }
  return filled;
}

module.exports = { inferPlace, fillMissingPlaces, stateFromPin };
