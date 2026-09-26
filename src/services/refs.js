'use strict';
// Resolves free-text Channel / Partner / Sales SPOC values from sheets to master records.
// Unknown values are created (flagged created_via = 'SYNC') so no sheet data is lost;
// admins can then rename, add aliases or deactivate them in Settings.
const n = require('../util/normalize');

class RefCache {
  constructor(db, { isDemo = false } = {}) { this.db = db; this.isDemo = isDemo; }

  async load() {
    // sequential: this.db may be a single transaction client
    const c = await this.db.query('SELECT channel_id, name, aliases FROM channels');
    const p = await this.db.query('SELECT partner_id, channel_id, name FROM partners');
    const u = await this.db.query('SELECT user_id, name, email, aliases FROM users');
    this.channels = new Map();
    for (const r of c.rows) {
      this.channels.set(n.nameKey(r.name), r.channel_id);
      for (const a of r.aliases || []) this.channels.set(n.nameKey(a), r.channel_id);
    }
    this.partners = new Map(p.rows.map((r) => [`${r.channel_id || 0}|${n.nameKey(r.name)}`, r.partner_id]));
    this.users = new Map();
    for (const r of u.rows) {
      this.users.set(n.nameKey(r.name), r.user_id);
      if (r.email) this.users.set(r.email.toLowerCase(), r.user_id);
      for (const a of r.aliases || []) this.users.set(n.nameKey(a), r.user_id);
    }
    return this;
  }

  async channel(raw) {
    const name = n.clean(raw); if (!name) return null;
    const k = n.nameKey(name);
    if (this.channels.has(k)) return this.channels.get(k);
    const { rows } = await this.db.query(
      `INSERT INTO channels (name, created_via, is_demo) VALUES ($1,'SYNC',$2)
       ON CONFLICT (lower(name)) DO UPDATE SET name = channels.name RETURNING channel_id`, [name, this.isDemo]);
    this.channels.set(k, rows[0].channel_id);
    return rows[0].channel_id;
  }

  async partner(raw, channelId) {
    const name = n.clean(raw); if (!name) return null;
    const key = `${channelId || 0}|${n.nameKey(name)}`;
    if (this.partners.has(key)) return this.partners.get(key);
    const { rows } = await this.db.query(
      `INSERT INTO partners (name, channel_id, created_via, is_demo) VALUES ($1,$2,'SYNC',$3)
       ON CONFLICT (coalesce(channel_id,0), lower(name)) DO UPDATE SET name = partners.name RETURNING partner_id`,
      [name, channelId, this.isDemo]);
    this.partners.set(key, rows[0].partner_id);
    return rows[0].partner_id;
  }

  async spoc(raw) {
    const v = n.clean(raw); if (!v) return null;
    const k = v.includes('@') ? v.toLowerCase() : n.nameKey(v);
    if (this.users.has(k)) return this.users.get(k);
    const isEmail = v.includes('@');
    const { rows } = await this.db.query(
      `INSERT INTO users (name, email, role, team, access_role, created_via, is_demo)
       VALUES ($1,$2,'Sales SPOC','Sales','NONE','SYNC',$3) RETURNING user_id`,
      [isEmail ? v.split('@')[0] : n.titleCase(v), isEmail ? v.toLowerCase() : null, this.isDemo]);
    this.users.set(k, rows[0].user_id);
    return rows[0].user_id;
  }
}

module.exports = { RefCache };
