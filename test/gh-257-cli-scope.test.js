'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cli = require('../ltj-cli');

test('3.0 不再匯出可能轉送 body token 的 GAS 入口', () => {
  assert.equal(cli.postLiteJiraApi, undefined);
});

test('CLI 專案預設與 mine 查詢遵守 MCP 同一範圍規則', async () => {
  const env = { LTJ_API_URL: 'https://example.com', LTJ_API_TOKEN: 'test-token', LTJ_PROJECT: 'MAIN' };
  const sent = [];
  const io = { log() {}, error() {} };
  const fetch = async (url) => {
    sent.push(new URL(url));
    return { status: 200, text: async () => JSON.stringify({ data: { items: [], nextCursor: null } }) };
  };
  assert.equal(await cli.runCli(['search'], env, io, fetch), 0);
  assert.equal(sent[0].searchParams.get('project'), 'MAIN');
  assert.equal(await cli.runCli(['search', '--mine', 'assignee'], env, io, fetch), 0);
  assert.equal(sent[1].searchParams.get('project'), null);
  assert.equal(sent[1].searchParams.get('mine'), 'assignee');
  assert.equal(await cli.runCli(['search', '--project', 'OTHER', '--mine', 'creator'], env, io, fetch), 0);
  assert.equal(sent[2].searchParams.get('project'), 'OTHER');
  assert.equal(await cli.runCli(['search', '--mine', 'creator', '--q', 'filter'], env, io, fetch), 2);
  assert.equal(sent.length, 3);
});
