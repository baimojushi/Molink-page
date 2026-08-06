const db = require('../database');

function stringifyProps(props) {
  if (!props || (typeof props === 'object' && Object.keys(props).length === 0)) return null;
  try {
    return JSON.stringify(props);
  } catch (error) {
    return JSON.stringify({ error: 'payload_serialize_failed' });
  }
}

function recordAppEvent({
  sessionId = null,
  deviceUuid = null,
  openid = null,
  orderId = null,
  exhibitionId = null,
  eventName,
  pageName = null,
  platform = null,
  serviceType = null,
  entrySource = null,
  artworkId = null,
  artworkCode = null,
  props = null
}) {
  if (!eventName) return null;
  try {
    return db.prepare(`
      INSERT INTO app_events (
        exhibition_id, session_id, device_uuid, openid, order_id, event_name, page_name,
        platform, service_type, entry_source, artwork_id, artwork_code, props_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      exhibitionId || null,
      sessionId || null,
      deviceUuid || null,
      openid || null,
      orderId || null,
      eventName,
      pageName || null,
      platform || null,
      serviceType || null,
      entrySource || null,
      artworkId || null,
      artworkCode || null,
      stringifyProps(props)
    );
  } catch (error) {
    console.warn('recordAppEvent failed:', error.message);
    return null;
  }
}

function recordOrderEvent({
  orderId,
  exhibitionId = null,
  deviceUuid = null,
  eventType,
  imageIndex = null,
  imageUrl = null,
  pageName = null,
  stayMs = null,
  enteredAt = null,
  leftAt = null,
  payload = null,
  actorType = null,
  actorId = null,
  platform = null,
  serviceType = null,
  eventResult = null,
  artworkId = null,
  artworkCode = null
}) {
  if (!orderId || !eventType) return null;
  try {
    return db.prepare(`
      INSERT INTO order_events (
        exhibition_id, order_id, device_uuid, event_type, image_index, image_url, page_name,
        stay_ms, entered_at, left_at, payload_json, actor_type, actor_id,
        platform, service_type, event_result, artwork_id, artwork_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      exhibitionId || null,
      orderId,
      deviceUuid || null,
      eventType,
      Number.isInteger(imageIndex) ? imageIndex : null,
      imageUrl || null,
      pageName || null,
      typeof stayMs === 'number' ? Math.max(0, Math.round(stayMs)) : null,
      enteredAt || null,
      leftAt || null,
      stringifyProps(payload),
      actorType || null,
      actorId || null,
      platform || null,
      serviceType || null,
      eventResult || null,
      artworkId || null,
      artworkCode || null
    );
  } catch (error) {
    console.warn('recordOrderEvent failed:', error.message);
    return null;
  }
}

module.exports = {
  recordAppEvent,
  recordOrderEvent
};
