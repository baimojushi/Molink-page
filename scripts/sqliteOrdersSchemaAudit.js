'use strict';

const db = require('../database');

function getColumn(name) {
  return db.prepare('PRAGMA table_info(orders)').all().find(column => column.name === name);
}

const tableSqlRow = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'"
).get();

const report = {
  database_path: db.name || null,
  orders_is_strict: Boolean(tableSqlRow && /\bSTRICT\b/i.test(String(tableSqlRow.sql || ''))),
  hanging_status: getColumn('hanging_status') || null,
  hanging_exit_code: getColumn('hanging_exit_code') || null
};

console.log(JSON.stringify(report, null, 2));

if (!report.hanging_status || !report.hanging_exit_code) process.exitCode = 2;
