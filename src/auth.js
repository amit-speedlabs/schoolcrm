'use strict';
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

const COOKIE = 'glf_session';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}
const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + ($3 || ' hours')::interval)`,
    [tokenHash(token), userId, String(config.sessionTtlHours)]);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${config.sessionTtlHours * 3600}${config.cookieSecure ? '; Secure' : ''}`);
}
async function destroySession(req, res) {
  const t = parseCookies(req.headers.cookie)[COOKIE];
  if (t) await db.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash(t)]);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

async function authenticate(req, res, next) {
  try {
    const t = parseCookies(req.headers.cookie)[COOKIE];
    if (t) {
      const { rows } = await db.query(
        `SELECT u.user_id, u.name, u.email, u.access_role FROM sessions s JOIN users u USING (user_id)
         WHERE s.token_hash=$1 AND s.expires_at > now() AND u.status='ACTIVE' AND u.access_role IN ('ADMIN','MANAGEMENT')`, [tokenHash(t)]);
      if (rows[0]) req.user = rows[0];
    }
    next();
  } catch (e) { next(e); }
}

function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  // CSRF defence for state-changing requests: SameSite=Lax cookie + required custom header
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-requested-with') !== 'glf-crm') {
    return res.status(403).json({ error: 'Missing request header' });
  }
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user || req.user.access_role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required' });
  next();
}

async function bootstrapAdmin(log = console.log) {
  const { email, password, name } = config.bootstrapAdmin;
  if (!email || !password) return;
  const { rows } = await db.query(`SELECT user_id FROM users WHERE access_role='ADMIN' LIMIT 1`);
  if (rows[0]) return;
  await db.query(
    `INSERT INTO users (name, email, role, team, access_role, password_hash, created_via) VALUES ($1,$2,'Administrator','Management','ADMIN',$3,'BOOTSTRAP')
     ON CONFLICT (lower(email)) WHERE email IS NOT NULL DO UPDATE SET access_role='ADMIN', password_hash=EXCLUDED.password_hash, status='ACTIVE'`,
    [name, email.toLowerCase(), hashPassword(password)]);
  log(`[auth] bootstrap admin created: ${email}`);
}

module.exports = { hashPassword, verifyPassword, createSession, destroySession, authenticate, requireLogin, requireAdmin, bootstrapAdmin };
