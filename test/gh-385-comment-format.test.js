'use strict';

// LiteJira GH-385 第二輪審查：留言跳脫改由 MCP 處理，不叫模型自己跳脫。
//   addComment / replyFeedback 新增 format=text|html，預設 text。
//   text：送出前 & → &amp;、< → &lt;（各一次）、換行 → <br>；伺服器消毒後讀回 bodyText 就是原字。
//   html：原樣送出（呼叫端自己寫白名單 HTML）。
//
// 對照表與 LiteJira 本庫 `v2/server/test/unit/comment-plaintext-wire-gh385.test.ts` **逐字同一份**：
// 這邊鎖「原字 → 送出字串」，那邊用伺服器真的消毒函式鎖「送出字串 → 讀回原字」。改一邊要改另一邊。

const test = require('node:test');
const assert = require('node:assert');

const { callTool, listTools } = require('../litejira-mcp-server');
const { plainTextToCommentHtml } = require('../litejira-v1-transport');
const { runCli } = require('../ltj-cli');

const WIRE_CASES = [
  ['付費 => 回失敗', '付費 => 回失敗'],
  ['a < b', 'a &lt; b'],
  ['第一行\n第二行\n\n第四行', '第一行<br>第二行<br><br>第四行'],
  ['Windows 換行\r\n第二行', 'Windows 換行<br>第二行'],
  ['<script>alert(1)</script>正文', '&lt;script>alert(1)&lt;/script>正文'],
  ['<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)>'],
  ['&lt;script&gt; 字面', '&amp;lt;script&amp;gt; 字面'],
  ['List<int> 與 Map<K,V>', 'List&lt;int> 與 Map&lt;K,V>'],
  ['若 x<y 則成立\n下一行', '若 x&lt;y 則成立<br>下一行'],
  ['https://x.test/a?id=1&region=tw&copy=2&para=3&not=4',
    'https://x.test/a?id=1&amp;region=tw&amp;copy=2&amp;para=3&amp;not=4'],
  ['原文寫著 &lt; 四個字', '原文寫著 &amp;lt; 四個字'],
  ['a </b c', 'a &lt;/b c'],
  ['a <!b c', 'a &lt;!b c'],
  ["Don't stop", "Don't stop"]
];

const BASE = 'https://litejira.example.com';
const TOKEN = 'ltj_pat_test_abcdefgh';
const KEY = 'gh385-format-key-0001';
const TICKET = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';

function cfg() {
  return { apiUrl: BASE, token: TOKEN, project: 'LTJ', enableWrites: true };
}

function okFetch(data) {
  const calls = [];
  const fetchImpl = function (url, init) {
    calls.push({ url: url, init: init });
    return Promise.resolve({
      status: 201,
      text: function () { return Promise.resolve(JSON.stringify({ data: data || { id: 'c1' } })); }
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

test('對照表：純文字 → 送出字串（& 與 < 各跳脫一次、換行成 <br>）', function () {
  for (const [plain, wire] of WIRE_CASES) {
    assert.strictEqual(plainTextToCommentHtml(plain), wire, JSON.stringify(plain));
  }
});

test('addComment schema：format 收 markdown|text|html（GH-428 起預設 markdown）', function () {
  const def = listTools().find((t) => t.name === 'litejira.addComment');
  assert.deepStrictEqual(def.inputSchema.properties.format.enum, ['markdown', 'text', 'html']);
  const reply = listTools().find((t) => t.name === 'litejira.replyFeedback');
  assert.deepStrictEqual(reply.inputSchema.properties.format.enum, ['markdown', 'text', 'html']);
});

test('addComment format=text＝純文字：送出前自動跳脫，format 本身不送到伺服器', async function () {
  const fetchImpl = okFetch();
  await callTool('litejira.addComment',
    { ticketId: TICKET, body: 'x<y & https://a.test/?a=1&copy=2', format: 'text', idempotencyKey: KEY }, cfg(), fetchImpl);
  const [sent] = sentBodies(fetchImpl);
  assert.deepStrictEqual(sent, { body: 'x&lt;y &amp; https://a.test/?a=1&amp;copy=2' });
});

test('addComment format=html：原樣送出', async function () {
  const fetchImpl = okFetch();
  await callTool('litejira.addComment',
    { ticketId: TICKET, body: '<p>a &lt; b</p>', format: 'html', idempotencyKey: KEY }, cfg(), fetchImpl);
  assert.deepStrictEqual(sentBodies(fetchImpl)[0], { body: '<p>a &lt; b</p>' });
});

test('addComment format 不合法值本機擋下、一發都不送', async function () {
  const fetchImpl = okFetch();
  await assert.rejects(() => callTool('litejira.addComment',
    { ticketId: TICKET, body: 'x', format: 'md', idempotencyKey: KEY }, cfg(), fetchImpl));
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test('replyFeedback 同一套：text 純文字跳脫、html 原樣', async function () {
  const text = okFetch();
  await callTool('litejira.replyFeedback',
    { ticketId: TICKET, content: 'List<int>\n下一行', format: 'text', idempotencyKey: KEY }, cfg(), text);
  assert.strictEqual(sentBodies(text)[0].body, 'List&lt;int><br>下一行');
  const html = okFetch();
  await callTool('litejira.replyFeedback',
    { ticketId: TICKET, content: '<p>x</p>', format: 'html', idempotencyKey: KEY }, cfg(), html);
  assert.strictEqual(sentBodies(html)[0].body, '<p>x</p>');
});

test('同一份輸入＋同一把鍵，送出字串逐字相同（冪等重送不會撞 request_mismatch）', async function () {
  const a = okFetch();
  const b = okFetch();
  const args = { ticketId: TICKET, body: 'a<b&c\nd', format: 'text', idempotencyKey: KEY };
  await callTool('litejira.addComment', args, cfg(), a);
  await callTool('litejira.addComment', args, cfg(), b);
  assert.deepStrictEqual(sentBodies(a), sentBodies(b));
});

test('說明：不再叫模型自己跳脫，改描述 format 參數', function () {
  for (const [name, param] of [['litejira.addComment', 'body'], ['litejira.replyFeedback', 'content']]) {
    const props = listTools().find((t) => t.name === name).inputSchema.properties;
    const d = props[param].description;
    assert.doesNotMatch(d, /先寫成 &lt;/, name + '：不得再要求自己跳脫');
    assert.doesNotMatch(d, /照原字顯示/, name);
    assert.match(d, /format/, name + '：要指向 format');
    assert.match(props.format.description, /自動/, name);
  }
});

test('CLI：ltj comment 預設純文字跳脫，--format html 原樣', async function () {
  const env = { LTJ_API_URL: BASE, LTJ_API_TOKEN: TOKEN, LTJ_MCP_ENABLE_WRITES: 'true' };
  const io = { log() {}, error() {} };
  const text = okFetch();
  assert.strictEqual(await runCli(['comment', TICKET, '--body', 'a<b&c', '--idempotency-key', KEY, '--yes'],
    env, io, text), 0);
  assert.strictEqual(sentBodies(text)[0].body, 'a&lt;b&amp;c');
  const html = okFetch();
  assert.strictEqual(await runCli(['comment', TICKET, '--body', '<p>x</p>', '--format', 'html',
    '--idempotency-key', KEY, '--yes'], env, io, html), 0);
  assert.strictEqual(sentBodies(html)[0].body, '<p>x</p>');
});
