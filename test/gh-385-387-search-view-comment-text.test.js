'use strict';

// LiteJira GH-385／GH-386／GH-387：MCP 這一側的三件事（後端在 UNTAG-LAB/LiteJira 同號 PR）。
//   GH-386：searchTickets 收 view=full|compact（後端 GET /tickets?view=），跨專案 mine 也可帶
//          ——它是回應投影，不是一般篩選（後端解析在路由層、不進 parseTicketFilter）。
//   GH-385：留言說明改正：body 是消毒後 HTML，純文字讀 bodyText；不再宣稱「Markdown 支援」。
//   GH-387：searchTickets 說明點名 mrLinks。
//
// 全部注入假 fetch，不接觸真 API、不讀憑證。

const test = require('node:test');
const assert = require('node:assert');

const { callTool, listTools } = require('../litejira-mcp-server');

const BASE = 'https://litejira.example.com';
const TOKEN = 'ltj_pat_test_abcdefgh';

function cfg(extra) {
  return Object.assign({ apiUrl: BASE, token: TOKEN, project: 'LTJ', enableWrites: false }, extra || {});
}

function okFetch() {
  const calls = [];
  const fetchImpl = function (url, init) {
    calls.push({ url: url, init: init });
    return Promise.resolve({
      status: 200,
      text: function () { return Promise.resolve(JSON.stringify({ data: { items: [], nextCursor: null } })); }
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function def(name) {
  return listTools().find((t) => t.name === name);
}

test('GH-386：searchTickets schema 有 view，值域 full|compact', function () {
  const view = def('litejira.searchTickets').inputSchema.properties.view;
  assert.ok(view, 'searchTickets 沒有 view 參數');
  assert.deepStrictEqual(view.enum, ['full', 'compact']);
});

test('GH-386：view=compact 原樣送進查詢字串；不帶就不送（後端預設 full）', async function () {
  const withView = okFetch();
  await callTool('litejira.searchTickets', { view: 'compact' }, cfg(), withView);
  assert.strictEqual(new URL(withView.calls[0].url).searchParams.get('view'), 'compact');

  const without = okFetch();
  await callTool('litejira.searchTickets', {}, cfg(), without);
  assert.strictEqual(new URL(without.calls[0].url).searchParams.has('view'), false);
});

test('GH-386：跨專案只帶 mine 時 view 照樣放行（投影不是一般篩選）', async function () {
  const fetchImpl = okFetch();
  await callTool('litejira.searchTickets', { mine: 'assignee', view: 'compact', limit: 100 },
    cfg({ project: '' }), fetchImpl);
  const params = new URL(fetchImpl.calls[0].url).searchParams;
  assert.strictEqual(params.get('mine'), 'assignee');
  assert.strictEqual(params.get('view'), 'compact');
  assert.strictEqual(params.has('project'), false);
});

test('GH-386：不合法的 view 本機擋下、一發都不送', async function () {
  const fetchImpl = okFetch();
  await assert.rejects(
    () => callTool('litejira.searchTickets', { view: 'tiny' }, cfg(), fetchImpl));
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test('GH-386／387：searchTickets 說明點名 view=compact 與 mrLinks', function () {
  const d = def('litejira.searchTickets').description;
  assert.match(d, /view=compact/);
  assert.match(d, /mrLinks/);
});

test('GH-385：留言相關說明不再宣稱 Markdown，並指向 bodyText', function () {
  const add = def('litejira.addComment').inputSchema.properties.body.description;
  const reply = def('litejira.replyFeedback').inputSchema.properties.content.description;
  for (const d of [add, reply]) {
    assert.doesNotMatch(d, /Markdown 支援/);
    assert.match(d, /不支援 Markdown/);
    // 審查 389：< 緊接字母會在寫入端被當標籤吃掉，說明必須要求呼叫端先跳脫，不得宣稱 < 可原字讀回
    assert.match(d, /< 一律先寫成 &lt;/);
    assert.doesNotMatch(d, /< > & 會存成/);
    assert.match(d, /HTML/);
  }
  for (const name of ['litejira.listComments', 'litejira.getActivityLog']) {
    assert.match(def(name).description, /bodyText/, name + ' 沒有指向 bodyText');
  }
});
