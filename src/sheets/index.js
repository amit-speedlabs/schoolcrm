'use strict';
const google = require('./googleAdapter');
const fixture = require('./fixtureAdapter');

function adapterFor(source) {
  if (source.adapter === 'fixture') return fixture;
  return google;
}
module.exports = { adapterFor, SheetsError: google.SheetsError };
