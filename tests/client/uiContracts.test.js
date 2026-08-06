'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('miniapp waiting page renders clear program and service failure actions', () => {
  const js = read('molink-miniapp-auction/pages/waiting/waiting.js');
  const wxml = read('molink-miniapp-auction/pages/waiting/waiting.wxml');
  assert.match(js, /failureProgram/);
  assert.match(wxml, /今日内进行人工处理/);
  assert.match(wxml, /查看历史记录/);
  assert.match(wxml, /重新提交照片/);
});

test('miniapp result keeps advisor copy and wall choices after delivery', () => {
  const wxml = read('molink-miniapp-auction/pages/result/result.wxml');
  assert.match(wxml, /艺术顾问解读/);
  assert.match(wxml, /艺术顾问建议与墙面选择/);
  assert.match(wxml, /当前效果/);
  assert.match(wxml, /生成所选墙面的追加效果/);
});

test('web waiting and delivery panels share persistent wall selection', () => {
  const html = read('public/index.html');
  assert.match(html, /function 显示失败状态/);
  assert.match(html, /function 加载网页墙面选择/);
  assert.match(html, /当前效果/);
  assert.ok((html.match(/id="web-wall-preferences"/g) || []).length >= 3);
});

test('failed alternative supplement jobs can be retried instead of reusing terminal job', () => {
  const source = read('routes/client.js');
  assert.match(source, /existingFailed/);
  assert.match(source, /!existingFailed && !failedCurrentPrimaryJob/);
});
