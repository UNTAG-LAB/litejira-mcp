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
  assert.match(update.description, /建立日 ≤ planningDoneDate ≤ dueDate \(no order vs startDate\)/);
  const batch = listTools().find(function (t) { return t.name === 'litejira.batchSetField'; });
  assert.match(batch.description, /planningDoneDate is ONLY for REQ and EPIC: a non-null value fails per ticket with 422/);
  assert.match(batch.inputSchema.properties.value.description, /planningDoneDate 只限 REQ／EPIC，其他類型逐張 422/);
});

test('GH-568：e4f3d93 的新日期順序在三處說明都守住，且不准改回「≤ 開始日」（審查 M7、M8）', function () {
  const tools = listTools();
  const update = tools.find(function (t) { return t.name === 'litejira.updateField'; });
  const create = tools.find(function (t) { return t.name === 'litejira.createTicket'; });
  const createParam = create.inputSchema.properties.planningDoneDate.description;
  assert.match(create.description, /建立日 ≤ planningDoneDate ≤ dueDate \(no order vs startDate\)/);
  assert.match(createParam, /與開始日先後不限/);
  // 反向：舊規則「規劃完成日 ≤ 開始日」出現在任何一處都要紅
  [update.description, create.description, createParam].forEach(function (text) {
    assert.doesNotMatch(text, /planningDoneDate ≤ startDate|規劃完成日 ≤ 開始日|≤ startDate ≤/);
  });
});

test('GH-568：其他說明字面也守住（審查 M10～M12）', function () {
  const tools = listTools();
  const update = tools.find(function (t) { return t.name === 'litejira.updateField'; });
  const create = tools.find(function (t) { return t.name === 'litejira.createTicket'; });
  assert.match(update.inputSchema.properties.value.description, /planningDoneDate 傳 YYYY-MM-DD（planningDoneDate 只有 REQ／EPIC 可填）/);
  assert.match(create.description, /The 19 additional fields may be null/);
  assert.match(update.description, /planningDoneDate is ONLY for REQ and EPIC — other types get 422; null always clears/);
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

test('GH-568：updateField／batchSetField 的 planningDoneDate 壞日期在本機就擋，不發請求（審查 M2）', async function () {
  const DATE_ERR = /參數「planningDoneDate」必須是 YYYY-MM-DD 格式的日期/;
  const isDateError = function (err) {
    return err instanceof LiteJiraTransportError && err.code === 'invalid_argument' && DATE_ERR.test(err.message);
  };
  const batch = function (value) {
    return buildRequest({
      baseUrl: BASE, token: TOKEN, action: 'batchSetField', idempotencyKey: KEY,
      params: { tickets: ['REQ-100'], fields: { planningDoneDate: value } }
    });
  };
  const update = async function (value, fetchImpl) {
    return callTool('litejira.updateField', {
      ticketId: 'REQ-100', field: 'planningDoneDate', value: value, idempotencyKey: KEY
    }, cfg(), fetchImpl);
  };

  // 對照組：同樣的寫法、日期正確就要能通過——證明下面被擋是因為日期，不是參數形狀（審查第二輪）
  assert.doesNotThrow(function () { batch('2026-11-20'); }, 'batchSetField 正確日期要能組出請求');
  const okImpl = okFetch({ id: UUID, key: 'REQ-100' });
  await update('2026-11-20', okImpl);
  assert.strictEqual(okImpl.calls.length, 1, 'updateField 正確日期要發出請求');

  for (const bad of ['2026/11/20', '2026-02-30', '20261120']) {
    assert.throws(function () { batch(bad); }, isDateError, 'batchSetField ' + bad);
    const fetchImpl = okFetch({ id: UUID, key: 'REQ-100' });
    // 工具層會把傳輸層錯誤包成 MCP 錯誤，類型不同、訊息原樣保留 ⇒ 核對訊息
    await assert.rejects(update(bad, fetchImpl), function (err) { return DATE_ERR.test(err.message); },
      'updateField ' + bad);
    assert.strictEqual(fetchImpl.calls.length, 0, 'updateField ' + bad + ' 不得發出請求');
  }
});
