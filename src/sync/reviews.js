'use strict';
// Admin resolution of possible duplicates / unmatched rows.
const db = require('../db');
const audit = require('../services/audit');
const { syncSource } = require('./syncEngine');

async function resolveReview(reviewId, action, { schoolId, user }) {
  const who = `user:${user.user_id} ${user.email}`;
  const review = await db.tx(async (c) => {
    const { rows: [r] } = await c.query('SELECT * FROM duplicate_reviews WHERE review_id=$1 FOR UPDATE', [reviewId]);
    if (!r) throw Object.assign(new Error('Review item not found'), { status: 404 });
    if (r.status !== 'OPEN') throw Object.assign(new Error(`Already resolved (${r.status})`), { status: 409 });
    let target = null; let status;
    if (action === 'link') {
      const { rows } = await c.query('SELECT school_id FROM schools WHERE school_id=$1', [schoolId]);
      if (!rows[0]) throw Object.assign(new Error(`School ${schoolId} not found`), { status: 400 });
      target = schoolId; status = 'LINKED';
    } else if (action === 'create') {
      const inc = r.incoming || {};
      if (!inc.school_name) throw Object.assign(new Error('Incoming row has no school name'), { status: 400 });
      const { rows: [s] } = await c.query(
        `INSERT INTO schools (school_name, city, state, pin_code, school_email, principal_name, principal_contact,
           coordinator_name, coordinator_phone, address, board, source, source_id, source_row, is_demo, created_by, updated_by)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
           CASE WHEN ds.is_demo THEN 'DEMO' ELSE 'GOOGLE_SHEETS' END, ds.source_id, $12, ds.is_demo, $13, $13
         FROM data_sources ds WHERE ds.source_id=$14 RETURNING school_id`,
        [inc.school_name, inc.city || null, inc.state || null, inc.pin_code || null, inc.school_email || null, inc.principal_name || null,
          inc.principal_contact || null, inc.coordinator_name || null, inc.coordinator_phone || null, inc.address || null, inc.board || null,
          r.source_row, who, r.source_id]);
      target = s.school_id; status = 'CREATED_NEW';
      await audit.logAction(c, { entityType: 'school', entityId: target, action: 'CREATE', note: `Created by admin from review #${reviewId}`, changedBy: who });
    } else if (action === 'dismiss') {
      status = 'DISMISSED';
    } else throw Object.assign(new Error('action must be link, create or dismiss'), { status: 400 });

    if (target) {
      // Force the row to be re-applied on the next sync, linked to the chosen school
      await c.query(`UPDATE source_rows SET school_id=$3, state='LINKED', reviewed=TRUE, row_hash='' WHERE source_id=$1 AND row_key=$2`, [r.source_id, r.row_key, target]);
    } else {
      await c.query(`UPDATE source_rows SET state='REJECTED' WHERE source_id=$1 AND row_key=$2`, [r.source_id, r.row_key]);
    }
    await c.query(`UPDATE duplicate_reviews SET status=$2, resolved_school_id=$3, resolved_by=$4, resolved_at=now(), updated_at=now() WHERE review_id=$1`,
      [reviewId, status, target, who]);
    await audit.logAction(c, { entityType: 'duplicate_review', entityId: reviewId, action: status, note: target ? `-> ${target}` : 'dismissed', changedBy: who });
    return { ...r, status, resolved_school_id: target };
  });
  let sync = null;
  if (review.resolved_school_id) sync = await syncSource(review.source_id, { triggeredBy: `review:${reviewId}` });
  return { review, sync };
}

module.exports = { resolveReview };
