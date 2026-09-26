'use strict';
const db = require('../src/db');
db.migrate().then(() => { console.log('Migrations complete'); return db.close(); })
  .catch((e) => { console.error(e.message); process.exit(1); });
