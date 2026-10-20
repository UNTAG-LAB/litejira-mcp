'use strict';

// LiteJira GH-428：AI 經 MCP 寫留言，預設格式改為 Markdown（含表格）。
//   markdown（預設）：內文原字送出，並帶 format=markdown；轉換與消毒在伺服器（API 直接寫入也能用同一份規則）。
//   text：維持 3.5 的行為（MCP 跳脫 & 與 <、換行轉 <br>），不送 format——舊伺服器也能用。
//   html：原樣送出，不送 format。
// 需求：LiteJira 網站 2.16.0 以上（POST /tickets/{id}/comments 收 format）。

const test = require('node:test');
const assert = require('node:assert');

const { callTool, listTools } = require('../litejira-mcp-server');
const { commentFieldsForWire, COMMENT_FORMAT_VALUES } = require('../litejira-v1-transport');
const { runCli } = require('../ltj-cli');

const BASE = 'https://litejira.example.com';
const TOKEN = 'ltj_pat_test_abcdefgh';
const KEY = 'gh428-markdown-key-0001';
const TICKET = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';
const MD = '## 結論\n\n| 項目 | 狀態 |\n|--|--|\n| A | **完成** |\n\n- a < b & c';

function cfg() {
  return { apiUrl: BASE, token: TOKEN, project: 'LTJ', enableWrites: true };
}

function okFetch() {
  const calls = [];
  const fetchImpl = function (url, init) {
    calls.push({ url: url, init: init });
    return Promise.resolve({
      status: 201,
      text: function () { return Promise.resolve(JSON.stringify({ data: { id: 'c1' } })); }
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function sentBodies(fetchImpl) {
  return fetchImpl.calls
    .filter((c) => /\/comments$/.test(new URL(c.url).pathname))
    .map((c) => JSON.parse(c.init.body));
}

test('格式值：markdown 排第一（預設），text 與 html 保留', function () {
  assert.deepStrictEqual(COMMENT_FORMAT_VALUES.slice(), ['markdown', 'text', 'html']);
  for (const name of ['litejira.addComment', 'litejira.replyFeedback']) {
    const props = listTools().find((t) => t.name === name).inputSchema.properties;
    assert.deepStrictEqual(props.format.enum, ['markdown', 'text', 'html'], name);
    assert.match(props.format.description, /預設 markdown/i, name);
  }
});

test('commentFieldsForWire：markdown 原字＋format；text 跳脫不帶 format；html 原樣', function () {
  assert.deepStrictEqual(commentFieldsForWire('a < b & **c**', undefined), { body: 'a < b & **c**', format: 'markdown' });
  assert.deepStrictEqual(commentFieldsForWire('a < b & **c**', 'markdown'), { body: 'a < b & **c**', format: 'markdown' });
  assert.deepStrictEqual(commentFieldsForWire('a < b\nc', 'text'), { body: 'a &lt; b<br>c' });
  assert.deepStrictEqual(commentFieldsForWire('<p>x</p>', 'html'), { body: '<p>x</p>' });
  assert.throws(() => commentFieldsForWire('x', 'md'), /format/);
});

test('addComment 不帶 format＝Markdown：原字送出並帶 format=markdown', async function () {
  const fetchImpl = okFetch();
  await callTool('litejira.addComment', { ticketId: TICKET, body: MD, idempotencyKey: KEY }, cfg(), fetchImpl);
  assert.deepStrictEqual(sentBodies(fetchImpl)[0], { body: MD, format: 'markdown' });
});

test('replyFeedback 不帶 format＝Markdown', async function () {
  const fetchImpl = okFetch();
  await callTool('litejira.replyFeedback', { ticketId: TICKET, content: MD, idempotencyKey: KEY }, cfg(), fetchImpl);
  assert.deepStrictEqual(sentBodies(fetchImpl)[0], { body: MD, format: 'markdown' });
});

test('addComment 帶 mentions 時也一起送 format', async function () {
  const fetchImpl = okFetch();
  const member = '11111111-2222-4333-8444-555555555555';
  await callTool('litejira.addComment',
    { ticketId: TICKET, body: '**看一下**', mentions: [member], idempotencyKey: KEY }, cfg(), fetchImpl);
  assert.deepStrictEqual(sentBodies(fetchImpl)[0], { body: '**看一下**', mentions: [member], format: 'markdown' });
});

test('說明：告訴模型預設可直接寫 Markdown（含表格），不必自己跳脫或寫 HTML', function () {
  for (const [name, param] of [['litejira.addComment', 'body'], ['litejira.replyFeedback', 'content']]) {
    const d = listTools().find((t) => t.name === name).inputSchema.properties[param].description;
    assert.match(d, /Markdown/, name);
    assert.match(d, /表格/, name);
    assert.doesNotMatch(d, /不支援 Markdown/, name);
  }
});

test('CLI：--format markdown 原字＋format；預設仍是純文字（CLI 行為不變）', async function () {
  const env = { LTJ_API_URL: BASE, LTJ_API_TOKEN: TOKEN, LTJ_MCP_ENABLE_WRITES: 'true' };
  const io = { log() {}, error() {} };
  const md = okFetch();
  assert.strictEqual(await runCli(['comment', TICKET, '--body', '**x** & y', '--format', 'markdown',
    '--idempotency-key', KEY, '--yes'], env, io, md), 0);
  assert.deepStrictEqual(sentBodies(md)[0], { body: '**x** & y', format: 'markdown' });
  const text = okFetch();
  assert.strictEqual(await runCli(['comment', TICKET, '--body', 'a<b', '--idempotency-key', KEY, '--yes'],
    env, io, text), 0);
  assert.deepStrictEqual(sentBodies(text)[0], { body: 'a&lt;b' });
});
