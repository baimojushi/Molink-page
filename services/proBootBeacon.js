// services/proBootBeacon.js
const records = new Map();

function clean(value, max = 120) {
  return String(value || '')
    .trim()
    .replace(/[^\w.-]/g, '_')
    .slice(0, max);
}

function record(body, req) {
  if (process.env.PRO_BOOT_BEACON_ENABLED !== '1') {
    return { accepted: false, reason: 'disabled' };
  }

  const instanceId = clean(body?.instance_id, 80);
  const stage = clean(body?.stage, 80);

  const expectedId = String(process.env.AUTODL_PRO_INSTANCE_ID || '').trim();

  if (!instanceId || !stage) {
    return { accepted: false, reason: 'missing_fields' };
  }

  if (expectedId && instanceId !== expectedId) {
    return { accepted: false, reason: 'unexpected_instance' };
  }

  const item = {
    instance_id: instanceId,
    stage,
    at: new Date().toISOString(),
    peer: String(
      req.headers['x-forwarded-for'] ||
      req.socket?.remoteAddress ||
      ''
    ).split(',')[0].trim()
  };

  records.set(instanceId, item);

  return {
    accepted: true,
    item
  };
}

function latest(instanceId) {
  return records.get(String(instanceId || '').trim()) || null;
}

module.exports = {
  record,
  latest
};
