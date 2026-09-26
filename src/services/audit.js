'use strict';
const fmt = (v) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

async function logChanges(db, { entityType, entityId, before, after, fields, changedBy, changeSource = 'MANUAL' }) {
  let n = 0;
  for (const f of fields) {
    const o = fmt(before ? before[f] : null); const v = fmt(after[f]);
    if (o === v) continue;
    await db.query(
      `INSERT INTO audit_logs (entity_type, entity_id, action, field, old_value, new_value, changed_by, change_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [entityType, String(entityId), before ? 'UPDATE' : 'CREATE', f, o, v, changedBy, changeSource]);
    n++;
  }
  return n;
}

async function logAction(db, { entityType, entityId, action, note, changedBy, changeSource = 'MANUAL' }) {
  await db.query(
    `INSERT INTO audit_logs (entity_type, entity_id, action, new_value, changed_by, change_source) VALUES ($1,$2,$3,$4,$5,$6)`,
    [entityType, String(entityId), action, note || null, changedBy, changeSource]);
}

module.exports = { logChanges, logAction };
