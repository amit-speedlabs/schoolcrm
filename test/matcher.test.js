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
