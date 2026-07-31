'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseBoundedInteger,
  parsePaginationQuery
} = require('../../services/pagination');

test('valid pagination values remain integers and are clamped', () => {
  assert.deepEqual(parsePaginationQuery({ page: '3', page_size: '25' }), {
    page: 3,
    pageSize: 25,
    offset: 50
  });
  assert.deepEqual(parsePaginationQuery({ page: '0', page_size: '999' }), {
    page: 1,
    pageSize: 50,
    offset: 0
  });
});

test('malformed pagination never propagates NaN into SQLite LIMIT/OFFSET', () => {
  for (const value of ['undefined', 'null', 'NaN', '1.5', '', '  ', {}, Infinity, NaN]) {
    const parsed = parsePaginationQuery({ page: value, page_size: value });
    assert.equal(Number.isSafeInteger(parsed.page), true);
    assert.equal(Number.isSafeInteger(parsed.pageSize), true);
    assert.equal(Number.isSafeInteger(parsed.offset), true);
    assert.deepEqual(parsed, { page: 1, pageSize: 20, offset: 0 });
  }
});

test('array query parameters use the first value safely', () => {
  assert.deepEqual(parsePaginationQuery({
    page: ['2', '999'],
    page_size: ['10', '50']
  }), {
    page: 2,
    pageSize: 10,
    offset: 10
  });
});

test('parseBoundedInteger rejects unsafe and non-integral numbers', () => {
  const options = { fallback: 7, min: 1, max: 50 };
  assert.equal(parseBoundedInteger(Number.MAX_SAFE_INTEGER + 1, options), 7);
  assert.equal(parseBoundedInteger(2.5, options), 7);
  assert.equal(parseBoundedInteger('2e2', options), 7);
  assert.equal(parseBoundedInteger('-4', options), 1);
});
