'use strict';

/**
 * Parse an integer query parameter without ever returning NaN, Infinity or a float.
 * Invalid input falls back to the supplied default, then the result is clamped.
 */
function parseBoundedInteger(value, { fallback, min, max }) {
  const raw = Array.isArray(value) ? value[0] : value;
  let parsed;

  if (typeof raw === 'number') {
    parsed = raw;
  } else {
    const text = String(raw == null ? '' : raw).trim();
    if (!/^[+-]?\d+$/.test(text)) return fallback;
    parsed = Number(text);
  }

  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parsePaginationQuery(query = {}) {
  const page = parseBoundedInteger(query.page, {
    fallback: 1,
    min: 1,
    max: 1_000_000
  });
  const pageSize = parseBoundedInteger(query.page_size, {
    fallback: 20,
    min: 1,
    max: 50
  });

  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
}

module.exports = {
  parseBoundedInteger,
  parsePaginationQuery
};
