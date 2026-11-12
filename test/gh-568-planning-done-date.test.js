'use strict';

// LiteJira GH-568：REQ／EPIC 的「規劃完成日」（planningDoneDate）。
// MCP 只負責「欄位收得進去、形狀在本機先把關」；「只有 REQ／EPIC 能填」與日期順序由伺服器裁決
// （本機不知道工單類型，也不重抄一份判定）。全部注入假 fetch，不接觸真 API。

const test = require('node:test');
const assert = require('node:assert');

const { callTool, listTools } = require('../litejira-mcp-server');
const {
  LiteJiraTransportError, NORMAL_FIELDS, SORT_VALUES, buildRequest
} = require('../litejira-v1-transport');

const BASE = 'https://litejira.example.com';
const V1 = BASE + '/api/v1';
const TOKEN = 'ltj_pat_test_abcdefgh';
const KEY = 'idem_key_0123456789';
const UUID = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';

function cfg() {
  return { apiUrl: BASE, token: TOKEN, project: 'LTJ', enableWrites: true };
}
function okFetch(data) {
  const calls = [];
  const fetchImpl = function (url, init) {
    calls.push({ url: url, init: init });
    return Promise.resolve({
      status: 200,
      text: function () { return Promise.resolve(JSON.stringify({ data: data })); }
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('GH-568：planningDoneDate 是一般欄位、可排序', function () {
  assert.ok(NORMAL_FIELDS.indexOf('planningDoneDate') !== -1);
  assert.ok(SORT_VALUES.indexOf('planningDoneDate') !== -1);
  const update = listTools().find(function (t) { return t.name === 'litejira.updateField'; });
  assert.ok(update.inputSchema.properties.field.enum.indexOf('planningDoneDate') !== -1);
  const create = listTools().find(function (t) { return t.name === 'litejira.createTicket'; });
  assert.ok(create.inputSchema.properties.planningDoneDate, 'createTicket 要公告 planningDoneDate');
  assert.match(create.description, /planningDoneDate[^.]*ONLY for REQ and EPIC/);
  // 第二輪審查：updateField／batchSetField 的說明也要講清楚類型限制與日期順序（改字時這裡會紅）
  assert.match(update.description, /planningDoneDate is ONLY for REQ and EPIC — other types get 422/);
  assert.match(update.description, /建立日 ≤ planningDoneDate ≤ startDate ≤ dueDate/);
  const batch = listTools().find(function (t) { return t.name === 'litejira.batchSetField'; });
  assert.match(batch.description, /planningDoneDate is ONLY for REQ and EPIC: a non-null value fails per ticket with 422/);
  assert.match(batch.inputSchema.properties.value.description, /planningDoneDate 只限 REQ／EPIC，其他類型逐張 422/);
});

test('GH-568：updateField planningDoneDate 走 PATCH、body 平攤；null 清空', async function () {
  for (const value of ['2026-11-20', null]) {
    const fetchImpl = okFetch({ id: UUID, key: 'REQ-100' });
    await callTool('litejira.updateField', {
      ticketId: 'REQ-100', field: 'planningDoneDate', value: value, idempotencyKey: KEY
    }, cfg(), fetchImpl);
    assert.strictEqual(fetchImpl.calls.length, 1);
    const call = fetchImpl.calls[0];
    assert.strictEqual(call.init.method, 'PATCH');
    assert.strictEqual(call.url, V1 + '/tickets/REQ-100');
    assert.deepStrictEqual(JSON.parse(call.init.body), { planningDoneDate: value });
  }
});

test('GH-568：createTicket 帶 planningDoneDate 原樣送出', async function () {
  const fetchImpl = okFetch({ id: UUID, key: 'REQ-101' });
  await callTool('litejira.createTicket', {
    project: 'LTJ', type: 'REQ', title: '合作案先規劃', planningDoneDate: '2026-11-20',
    startDate: '2026-11-21', dueDate: '2026-12-05', idempotencyKey: KEY
  }, cfg(), fetchImpl);
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.strictEqual(body.planningDoneDate, '2026-11-20');
});

test('GH-568：planningDoneDate 的日期形狀在本機先擋（同 startDate／dueDate）', function () {
  ['2026/11/20', '2026-02-30', '20261120', '2026-11-20T00:00:00Z'].forEach(function (bad) {
    assert.throws(function () {
      buildRequest({
        baseUrl: BASE, token: TOKEN, action: 'createTicket', idempotencyKey: KEY,
        params: { project: 'LTJ', type: 'REQ', title: 'x', planningDoneDate: bad }
      });
    }, function (err) {
      return err instanceof LiteJiraTransportError && err.code === 'invalid_argument';
    }, bad);
  });
});
