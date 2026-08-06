'use strict';

function safeArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function finalUrl(record = {}) {
  return record.final_image_url || record.image_url || record.r2_url || record.permanent_url || '';
}

function deliveredWallId(order = {}) {
  const records = safeArray(order.delivery_result_records_json);
  const images = safeArray(order.delivery_images);
  const firstImage = String(images[0] || '');
  if (firstImage) {
    const match = records.find(record => String(finalUrl(record)) === firstImage);
    if (match && match.wall_id) return String(match.wall_id);
  }
  const firstRendered = records.find(record => finalUrl(record));
  return firstRendered && firstRendered.wall_id ? String(firstRendered.wall_id) : '';
}

function readLatestPreferences(db, orderId) {
  if (!db || !orderId) return [];
  try {
    return db.prepare(`
      SELECT p.* FROM user_wall_preferences p
      INNER JOIN (
        SELECT chosen_wall_id, MAX(rowid) AS latest_rowid
        FROM user_wall_preferences
        WHERE order_id = ?
        GROUP BY chosen_wall_id
      ) latest ON latest.latest_rowid = p.rowid
      ORDER BY p.created_at ASC, p.rowid ASC
    `).all(orderId);
  } catch (_) {
    return [];
  }
}

function buildWallPreferenceState(db, order = {}) {
  const rows = readLatestPreferences(db, order.id);
  const byWall = {};
  rows.forEach(row => {
    const wallId = String(row.chosen_wall_id || '');
    if (!wallId) return;
    const jobId = String(row.supplement_job_id || '');
    let status = String(row.supplement_status || '').trim().toLowerCase();
    if (!status) status = jobId ? 'pending' : 'selected';
    byWall[wallId] = {
      selected_by_user: true,
      supplement_status: status,
      supplement_job_id: jobId,
      wallpaper_opt_in: Number(row.wallpaper_opt_in || 0) === 1
    };
  });

  const isDelivered = ['delivered', 'viewed', 'downloaded'].includes(String(order.status || ''));
  const currentWallId = isDelivered ? deliveredWallId(order) : '';
  return {
    current_effect_wall_id: currentWallId,
    has_user_selection: rows.length > 0,
    has_pending_supplement: Object.values(byWall).some(item => item.supplement_status === 'pending'),
    by_wall: byWall
  };
}

function applyWallPreferenceState(thinking, state) {
  if (!thinking || !Array.isArray(thinking.candidates)) return thinking;
  const currentWallId = String(state && state.current_effect_wall_id || '');
  const byWall = (state && state.by_wall) || {};
  return Object.assign({}, thinking, {
    current_effect_wall_id: currentWallId || null,
    has_user_selection: Boolean(state && state.has_user_selection),
    has_pending_supplement: Boolean(state && state.has_pending_supplement),
    candidates: thinking.candidates.map(candidate => {
      const wallId = String(candidate.wall_id || '');
      const pref = byWall[wallId] || {};
      return Object.assign({}, candidate, pref, {
        current_effect: Boolean(currentWallId && wallId === currentWallId),
        supplement_status: pref.supplement_status || 'idle',
        selected_by_user: pref.selected_by_user === true
      });
    })
  });
}

module.exports = {
  safeArray,
  finalUrl,
  deliveredWallId,
  readLatestPreferences,
  buildWallPreferenceState,
  applyWallPreferenceState
};
