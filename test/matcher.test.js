'use strict';
// Name matching must not flag different schools that only share generic words.
const test = require('node:test');
const assert = require('node:assert/strict');
const { match } = require('../src/sync/matcher');

const existing = [
  { school_id: 'SCH000018', school_name: 'Amity international school', city: 'Surat' },
  { school_id: 'SCH000043', school_name: 'Himat English School', city: 'Himmtnagar' },
  { school_id: 'SCH000003', school_name: 'Surat Vidya Mandir', city: 'Surat' },
];

test('schools sharing only words like "International" or "English School" are not possible duplicates', () => {
  for (const [name, city] of [['Krishna international School', 'Surat'], ['Jalaram International School', 'Surat'], ['New English School', 'Himmtnagar']]) {
    assert.equal(match({ school_name: name, city }, existing).decision, 'NONE', name);
  }
});

test('real spelling variants are still sent to review', () => {
  const r = match({ school_name: 'Surat Vidhya Mandir School', city: 'Surat' }, existing);
  assert.equal(r.decision, 'REVIEW');
  assert.equal(r.candidates[0].school_id, 'SCH000003');
  assert.equal(match({ school_name: 'Amity School', city: 'Surat' }, existing).candidates[0].school_id, 'SCH000018');
});

test('Navsari / Surat review queue: different schools with similar endings are not flagged, real matches are', () => {
  const live = [
    { school_id: 'SCH000106', school_name: 'Sitanjali highschool', city: 'Navsari' },
    { school_id: 'SCH000105', school_name: 'R D patel Highschool', city: 'Navsari' },
    { school_id: 'SCH000146', school_name: 'St marks school', city: 'Surat' },
    { school_id: 'SCH000068', school_name: 'Radiant International', city: 'Surat', coordinator_phone: '9876543210' },
  ];
  assert.equal(match({ school_name: 'Ancheli highschool', city: 'Navsari' }, live).decision, 'NONE');
  assert.equal(match({ school_name: 'ShriP N PATEL HIGHSCHOOL', city: 'Navsari' }, live).decision, 'NONE');
  assert.equal(match({ school_name: 'St Marks CBSE school', city: 'Surat' }, live).candidates[0].school_id, 'SCH000146');
  // a misspelt "International" plus the same coordinator phone links on its own
  const r = match({ school_name: 'Radiant Intetnational', city: 'Surat', coordinator_phone: '9876543210' }, live);
  assert.equal(r.decision, 'MATCH'); assert.equal(r.school_id, 'SCH000068');
});

const { inferPlace } = require('../src/services/geo');
test('state is inferred from city, address or PIN, and never from a common word mid-address', () => {
  const geo = [{ state: 'Maharashtra', city: 'Kolhapur' }, { state: 'Madhya Pradesh', city: 'Sagar' },
    { state: 'Bihar', city: 'Aurangabad' }, { state: 'Maharashtra', city: 'Aurangabad' }];
  assert.deepEqual(inferPlace({ address: 'Near bus stand, Kolhapur' }, geo), { state: 'Maharashtra', city: 'Kolhapur' });
  assert.equal(inferPlace({ address: 'Shivaji Peth 416 012' }, geo).state, 'Maharashtra');
  assert.equal(inferPlace({ address: 'Plot 3, Sagar Colony, Maharastra' }, geo).state, 'Maharashtra');
  assert.equal(inferPlace({ address: 'Main road, Sagar Colony' }, geo).state, null);
  assert.equal(inferPlace({ city: 'Aurangabad' }, geo).state, null);
});
