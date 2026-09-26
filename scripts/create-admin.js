'use strict';
// Usage: node scripts/create-admin.js <email> <password> [name] [ADMIN|MANAGEMENT]
const db = require('../src/db');
const { hashPassword } = require('../src/auth');
const { normEmail } = require('../src/util/normalize');

(async () => {
  const [email, password, name = 'Administrator', role = 'ADMIN'] = process.argv.slice(2);
  const e = normEmail(email);
  if (!email || e.error) throw new Error('A valid email is required');
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');
  if (!['ADMIN', 'MANAGEMENT'].includes(role)) throw new Error('Role must be ADMIN or MANAGEMENT');
  await db.migrate(() => {});
  await db.query(
    `INSERT INTO users (name, email, role, team, access_role, password_hash, created_via)
     VALUES ($1,$2,$4,'Management',$4,$3,'BOOTSTRAP')
     ON CONFLICT (lower(email)) WHERE email IS NOT NULL
     DO UPDATE SET access_role=EXCLUDED.access_role, password_hash=EXCLUDED.password_hash, status='ACTIVE', updated_at=now()`,
    [name, e.value, hashPassword(password), role]);
  console.log(`${role} user ready: ${e.value}`);
  await db.close();
})().catch(async (err) => { console.error(err.message); await db.close(); process.exit(1); });
