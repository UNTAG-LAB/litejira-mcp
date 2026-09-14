'use strict';

// GH-257 第三包：9 個基本寫入工具接上 API v1。
// 全部測試注入假 fetch，走真正的 JSON-RPC handler / callTool，不接觸真 API、不讀憑證。
// 驗的是「真的送出什麼」：method / URL / header / body，以及「什麼情況一發都不送」。

const test = require('node:test');
const assert = require('node:assert');

const {
  callTool,
  handleJsonRpcRequest,
  listTools
} = require('../litejira-mcp-server');
const {
  LiteJiraTransportError,
  buildRequest,
  callV1
} = require('../litejira-v1-transport');

const BASE = 'https://litejira.example.com';
const V1 = BASE + '/api/v1';
const TOKEN = 'ltj_pat_test_abcdefgh';
const KEY = 'idem_key_0123456789';
const UUID = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';
const UUID2 = '8a7b6c5d-4e3f-4a2b-9c8d-7e6f5a4b3c2d';
const UUID3 = '11112222-3333-4444-5555-666677778888';

// 本包接線的 9 個基本寫入工具。
const WRITE_TOOLS = [
  ['litejira.createTicket', { type: 'BUG', title: '登入逾時' }],
  ['litejira.addComment', { ticketId: 'BUG-481', body: '已修正' }],
  ['litejira.attachLink', { ticketId: 'BUG-481', url: 'https://example.com/a.png' }],
  ['litejira.removeAttachment', { ticketId: 'BUG-481', attachmentId: UUID3 }],
  ['litejira.linkTickets', { childId: 'BUG-481', parentId: UUID }],
  ['litejira.reassignTicket', { ticketId: 'BUG-481', assigneeId: UUID2, reason: '換人接手' }],
  ['litejira.convertTicketType', { ticketId: 'BUG-481', type: 'REQ' }],
  ['litejira.toggleWatch', { ticketId: 'BUG-481', watching: true }],
  ['litejira.transitionTicket', { ticketId: 'BUG-481', action: '開始開發' }]
];

// ── tools/list：9 個寫入工具重新可見，且 schema 是真的 v1 形狀 ──

test('9 個基本寫入工具回到 tools/list，且都要求 idempotencyKey', async function () {
  const listed = listTools();
  WRITE_TOOLS.forEach(function (pair) {
    const def = listed.find(function (t) { return t.name === pair[0]; });
    assert.ok(def, pair[0] + ' 應該出現在 tools/list');
    assert.ok(def.inputSchema.required.indexOf('idempotencyKey') !== -1,
      pair[0] + ' 必須要求 idempotencyKey');
    assert.ok(def.inputSchema.properties.idempotencyKey, pair[0] + ' 缺 idempotencyKey schema');
  });
});

test('idempotencyKey 的說明不再宣稱「server 端未真正去重」', async function () {
  const def = listTools().find(function (t) { return t.name === 'litejira.addComment'; });
  const text = def.inputSchema.properties.idempotencyKey.description;
  assert.ok(text.indexOf('未真正去重') === -1, '舊的錯誤宣告必須移除');
  assert.match(text, /去重/);
});

test('寫入工具的 schema 直接對齊 v1 契約參數名（不留舊名）', async function () {
  const byName = {};
  listTools().forEach(function (t) { byName[t.name] = t.inputSchema.properties; });

  // 舊名一律不存在
  assert.strictEqual(byName['litejira.addComment'].content, undefined);
  assert.strictEqual(byName['litejira.reassignTicket'].newAssignee, undefined);
  assert.strictEqual(byName['litejira.convertTicketType'].newType, undefined);
  assert.strictEqual(byName['litejira.transitionTicket'].extraFields, undefined);
  assert.strictEqual(byName['litejira.removeAttachment'].url, undefined);
  assert.strictEqual(byName['litejira.attachLink'].kind, undefined);

  // 新名存在
  assert.ok(byName['litejira.addComment'].body);
  assert.ok(byName['litejira.reassignTicket'].assigneeId);
  assert.ok(byName['litejira.convertTicketType'].type);
  assert.ok(byName['litejira.transitionTicket'].fields);
  assert.ok(byName['litejira.removeAttachment'].attachmentId);
  assert.ok(byName['litejira.toggleWatch'].watching);

  // 轉型目標不含 IDEA / STD
  const targets = byName['litejira.convertTicketType'].type.enum;
  assert.deepStrictEqual(targets.slice().sort(), ['BUG', 'EPIC', 'REQ', 'TASK']);

  // expectedUpdatedAt 是字串（ISO），不是毫秒數字
  ['litejira.linkTickets', 'litejira.reassignTicket', 'litejira.convertTicketType', 'litejira.transitionTicket']
    .forEach(function (name) {
      assert.strictEqual(byName[name].expectedUpdatedAt.type, 'string', name);
    });
  // 留言端點不做樂觀鎖
  assert.strictEqual(byName['litejira.addComment'].expectedUpdatedAt, undefined);
});

// ── 寫入開關：關閉時一發都不送 ──

test('LTJ_MCP_ENABLE_WRITES 未開時，9 個寫入工具全部被擋且不送出任何請求', async function () {
  const fetchImpl = neverFetch();
  for (const pair of WRITE_TOOLS) {
    const args = Object.assign({ idempotencyKey: KEY }, pair[1]);
    const response = await rpc('tools/call', { name: pair[0], arguments: args },
      cfg({ enableWrites: false }), fetchImpl);
    assert.ok(response.error, pair[0] + ' 應該被擋下');
    assert.strictEqual(response.error.data.code, 'WRITES_DISABLED', pair[0]);
  }
  assert.strictEqual(fetchImpl.calls.length, 0);
});

// ── 逐一：真 method / URL / header / body ──

test('createTicket 送 POST /api/v1/tickets，平攤 body，project 取 LTJ_PROJECT', async function () {
  const fetchImpl = okFetch({ id: UUID, key: 'BUG-482' });
  const result = await callTool('litejira.createTicket', {
    type: 'BUG', title: '登入逾時', priority: 'P1-高',
    description: '重現步驟：…', assigneeId: UUID2,
    targetVersion: '1.2.0', foundVersion: '1.1.9',
    idempotencyKey: KEY
  }, cfg(), fetchImpl);

  assert.strictEqual(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.strictEqual(call.init.method, 'POST');
  assert.strictEqual(call.url, V1 + '/tickets');
  assert.strictEqual(call.init.headers.Authorization, 'Bearer ' + TOKEN);
  assert.strictEqual(call.init.headers['Idempotency-Key'], KEY);
  assert.strictEqual(call.init.headers['Content-Type'], 'application/json');
  assert.strictEqual(call.init.redirect, 'manual');
  assert.deepStrictEqual(JSON.parse(call.init.body), {
    project: 'LTJ', type: 'BUG', title: '登入逾時', priority: 'P1-高',
    description: '重現步驟：…', assigneeId: UUID2,
    targetVersion: '1.2.0', foundVersion: '1.1.9'
  });
  // 冪等鍵只走 header，不得混進 body 或 query
  assert.ok(call.init.body.indexOf(KEY) === -1);
  assert.ok(call.url.indexOf(KEY) === -1);
  assert.deepStrictEqual(result.structuredContent, { id: UUID, key: 'BUG-482' });
});

test('createTicket：既沒帶 project 也沒有 LTJ_PROJECT → 明確報錯且不送出', async function () {
  const fetchImpl = neverFetch();
  const response = await rpc('tools/call', {
    name: 'litejira.createTicket',
    arguments: { type: 'BUG', title: 'x', idempotencyKey: KEY }
  }, cfg({ project: '' }), fetchImpl);

  assert.strictEqual(response.error.data.code, 'PROJECT_REQUIRED');
  assert.strictEqual(fetchImpl.calls.length, 0);
});

// 後端已核對過的建單欄位全集：核心 6 欄 + 18 個選填欄位。
const CREATE_OPTIONAL_FIELDS = [
  'module', 'subtype', 'releaseMethod', 'stdLevel2', 'stdLevel3',
  'startDate', 'dueDate', 'tags', 'mrUrl',
  'reproSteps', 'expectedResult', 'fixMethod', 'validationMethod',
  'verifiableVersionAlpha', 'verifiableVersionRelease',
  'ownerId', 'targetVersion', 'foundVersion'
];

// 全欄位建單：一次填齊，逐欄核對真的送出去的 body（不是「有收下」而已）。
test('createTicket：18 個選填欄位全部帶齊時，原樣平攤進 body 送出', async function () {
  const fetchImpl = okFetch({ id: UUID, key: 'BUG-483' });
  const full = {
    project: 'LTJ', type: 'BUG', title: '登入逾時', priority: 'P1-高',
    description: '登入後 30 秒被登出', assigneeId: UUID2, ownerId: UUID3,
    module: '帳號', subtype: '功能缺陷', releaseMethod: '熱更',
    stdLevel2: '安全', stdLevel3: '驗證',
    startDate: '2026-09-14', dueDate: '2026-09-30',
    tags: ['登入', '逾時'], mrUrl: 'https://git.example.com/mr/42',
    reproSteps: '1. 登入 2. 等 30 秒', expectedResult: '維持登入狀態',
    fixMethod: '延長 session', validationMethod: '手動驗證',
    verifiableVersionAlpha: '1.2.0-alpha', verifiableVersionRelease: '1.2.0',
    targetVersion: '1.2.0', foundVersion: '1.1.9'
  };
  await callTool('litejira.createTicket',
    Object.assign({ idempotencyKey: KEY }, full), cfg(), fetchImpl);

  assert.strictEqual(fetchImpl.calls.length, 1);
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepStrictEqual(sent, full);
  // 每一個選填欄位都真的出現在 body：漏掉任何一個就是資料沒寫進去
  CREATE_OPTIONAL_FIELDS.forEach(function (key) {
    assert.ok(Object.prototype.hasOwnProperty.call(sent, key), key + ' 沒被送出');
  });
  // 冪等鍵仍然只走 header
  assert.strictEqual(fetchImpl.calls[0].init.headers['Idempotency-Key'], KEY);
  assert.ok(fetchImpl.calls[0].init.body.indexOf(KEY) === -1);
});

test('createTicket：18 個附加資料欄可以明確傳 null', async function () {
  const fetchImpl = okFetch({ id: UUID });
  const args = { type: 'BUG', title: 'x', idempotencyKey: KEY };
  CREATE_OPTIONAL_FIELDS.forEach(function (key) { args[key] = null; });
  await callTool('litejira.createTicket', args, cfg(), fetchImpl);

  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  // 核心必填照舊；其餘一律以 null 原樣送出（null 是「明確不設」，不是「略過」）
  assert.strictEqual(sent.project, 'LTJ');
  assert.strictEqual(sent.type, 'BUG');
  assert.strictEqual(sent.title, 'x');
  CREATE_OPTIONAL_FIELDS.forEach(function (key) {
    assert.strictEqual(sent[key], null, key + ' 應該是 null');
  });
});

// 後端 validateFieldValue 對選填 TEXT_FIELDS 只驗 typeof string（空字串照收，title 例外必須非空）。
// 這層若把空字串當成錯誤，合法的建單輸入會被前置擋掉，是契約不相容。
const CREATE_EMPTY_OK_TEXT = [
  'module', 'subtype', 'stdLevel2', 'stdLevel3', 'mrUrl',
  'reproSteps', 'expectedResult', 'fixMethod', 'validationMethod',
  'verifiableVersionAlpha', 'verifiableVersionRelease',
  'description', 'targetVersion', 'foundVersion'
];

test('createTicket：選填文字欄位收空字串，且原樣（空字串，不是 null、不是省略）送出', async function () {
  const fetchImpl = okFetch({ id: UUID });
  const args = { type: 'BUG', title: 'x', idempotencyKey: KEY };
  CREATE_EMPTY_OK_TEXT.forEach(function (key) { args[key] = ''; });

  await callTool('litejira.createTicket', args, cfg(), fetchImpl);

  assert.strictEqual(fetchImpl.calls.length, 1, '空字串是合法輸入，必須真的送出');
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  CREATE_EMPTY_OK_TEXT.forEach(function (key) {
    assert.ok(Object.prototype.hasOwnProperty.call(sent, key), key + ' 沒被送出');
    assert.strictEqual(sent[key], '', key + ' 必須原樣是空字串');
  });
  // 核心欄位不受影響
  assert.strictEqual(sent.project, 'LTJ');
  assert.strictEqual(sent.type, 'BUG');
  assert.strictEqual(sent.title, 'x');
});

test('createTicket：空字串的放行只限選填文字欄位，核心三欄仍要求非空', function () {
  [{ project: '' }, { type: '' }, { title: '' }].forEach(function (one) {
    assert.throws(function () {
      buildRequest({
        baseUrl: BASE, token: TOKEN, action: 'createTicket', idempotencyKey: KEY,
        params: Object.assign({ project: 'LTJ', type: 'BUG', title: 'x' }, one)
      });
    }, function (err) {
      return err instanceof LiteJiraTransportError && err.code === 'invalid_argument';
    }, JSON.stringify(one));
  });
});

test('createTicket：核心必填仍是 project / type / title，缺了就擋在本機', async function () {
  const never = neverFetch();
  for (const missing of [
    [{ title: 'x' }, /type/],
    [{ type: 'BUG' }, /title/]
  ]) {
    const args = Object.assign({ idempotencyKey: KEY }, missing[0]);
    const response = await rpc('tools/call', { name: 'litejira.createTicket', arguments: args }, cfg(), never);
    assert.strictEqual(response.error.data.code, 'VALIDATION_FAILED', JSON.stringify(missing[0]));
    assert.match(response.error.message, missing[1]);
  }
  assert.strictEqual(never.calls.length, 0);
});

test('createTicket：型別不合的選填值在送出前擋下（日期 / tags / UUID / 受控值空字串）', async function () {
  const never = neverFetch();
  const bad = [
    { priority: null }, { description: null }, { assigneeId: null },
    { startDate: '2026/09/14' },          // 非 YYYY-MM-DD
    { dueDate: '2026-09-30T00:00:00Z' },  // 帶時間的 ISO
    { tags: '登入,逾時' },                 // 逗號串接的單一字串
    { tags: [123] },                      // 非字串元素
    { ownerId: '阿明' },                   // 顯示名不是 UUID
    { assigneeId: 'BUG-481' },            // 工單 key 不是成員 UUID
    { reproSteps: 123 },                  // 文字欄位收到數字
    { releaseMethod: '' }                 // 受控值欄位：空字串不在後端值域內
  ];
  for (const one of bad) {
    const args = Object.assign({ type: 'BUG', title: 'x', idempotencyKey: KEY }, one);
    const response = await rpc('tools/call', { name: 'litejira.createTicket', arguments: args }, cfg(), never);
    const key = Object.keys(one)[0];
    assert.ok(response.error, key + ' 應該被擋下：' + JSON.stringify(one));
    assert.ok(response.error.message.indexOf(key) !== -1, key + ' 訊息要指名該參數');
  }
  assert.strictEqual(never.calls.length, 0);
});

test('createTicket：傳輸層對日期 / tags 的形狀把關（MCP schema 之外的第二道）', function () {
  const base = { project: 'LTJ', type: 'BUG', title: 'x' };
  [
    { dueDate: '2026-02-30' },     // 格式對、日子不存在
    { startDate: '2026-02-29' },   // 2026 不是閏年
    { startDate: '20260914' },
    { tags: ['ok', ''] },
    { tags: {} }
  ].forEach(function (one) {
    assert.throws(function () {
      buildRequest({
        baseUrl: BASE, token: TOKEN, action: 'createTicket', idempotencyKey: KEY,
        params: Object.assign({}, base, one)
      });
    }, function (err) {
      return err instanceof LiteJiraTransportError && err.code === 'invalid_argument';
    }, JSON.stringify(one));
  });

  // 合法的日期 / tags 原樣通過
  const ok = buildRequest({
    baseUrl: BASE, token: TOKEN, action: 'createTicket', idempotencyKey: KEY,
    params: Object.assign({ startDate: '2024-02-29', dueDate: '2026-03-01', tags: ['a', 'b'] }, base)
  });
  const sent = JSON.parse(ok.body);
  assert.strictEqual(sent.startDate, '2024-02-29');
  assert.strictEqual(sent.dueDate, '2026-03-01');
  assert.deepStrictEqual(sent.tags, ['a', 'b']);
});

test('createTicket：releaseMethod / priority 的值域由後端裁決，本層不自創 enum', async function () {
  // priority 是已知受控值：照舊原樣送出
  const fetchImpl = okFetch({ id: UUID });
  await callTool('litejira.createTicket', {
    type: 'BUG', title: 'x', priority: 'P0-緊急', releaseMethod: '熱更', idempotencyKey: KEY
  }, cfg(), fetchImpl);
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.strictEqual(sent.priority, 'P0-緊急');
  assert.strictEqual(sent.releaseMethod, '熱更');

  // releaseMethod 的其他值不在本機被擋：交由伺服器驗證（不寫死值域，免得後端新增值時誤擋）
  const forwarded = okFetch({ id: UUID });
  await callTool('litejira.createTicket', {
    type: 'BUG', title: 'x', releaseMethod: '停服', idempotencyKey: KEY
  }, cfg(), forwarded);
  assert.strictEqual(JSON.parse(forwarded.calls[0].init.body).releaseMethod, '停服');

  // 傳輸層同樣只驗形狀，把未知值原樣往後端送（由後端回 invalid_argument）
  const request = buildRequest({
    baseUrl: BASE, token: TOKEN, action: 'createTicket', idempotencyKey: KEY,
    params: { project: 'LTJ', type: 'BUG', title: 'x', releaseMethod: '未來新增的方式' }
  });
  assert.strictEqual(JSON.parse(request.body).releaseMethod, '未來新增的方式');
});

test('createTicket：只剩「舊名 / 不屬於建單」的參數被拒絕並指路', async function () {
  const fetchImpl = neverFetch();
  const cases = [
    [{ assignee: '思源' }, /assigneeId/],
    [{ owner: '阿明' }, /ownerId/],
    [{ version: '1.2.0' }, /targetVersion/],
    [{ verifyMethod: '手動驗' }, /validationMethod/],
    [{ notes: '備註' }, /description/],
    // 狀態 / 父子 / 樂觀鎖本來就不屬於建單端點
    [{ parentId: UUID }, /linkTickets/],
    [{ status: '開發中' }, /transitionTicket/],
    [{ expectedUpdatedAt: '2026-09-11T03:04:05.123456Z' }, /expectedUpdatedAt/]
  ];
  for (const pair of cases) {
    const args = Object.assign({ type: 'BUG', title: 'x', idempotencyKey: KEY }, pair[0]);
    const response = await rpc('tools/call', { name: 'litejira.createTicket', arguments: args }, cfg(), fetchImpl);
    const key = Object.keys(pair[0])[0];
    assert.strictEqual(response.error.data.code, 'VALIDATION_FAILED', key);
    assert.ok(response.error.message.indexOf(key) !== -1, key + ' 訊息要指名該參數');
    assert.match(response.error.message, pair[1], key + ' 訊息要指路');
  }
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test('createTicket 的說明與 schema 不再叫人把欄位寫進 description 或建單後再補', async function () {
  const def = listTools().find(function (t) { return t.name === 'litejira.createTicket'; });
  const props = def.inputSchema.properties;

  // 18 個選填欄位都要在 schema 裡，而且全部可為 null
  CREATE_OPTIONAL_FIELDS.forEach(function (key) {
    assert.ok(props[key], 'schema 缺 ' + key);
    const types = Array.isArray(props[key].type) ? props[key].type : [props[key].type];
    assert.ok(types.indexOf('null') !== -1, key + ' 應該可為 null');
  });
  ['priority', 'description', 'assigneeId'].forEach(function (key) {
    const types = Array.isArray(props[key].type) ? props[key].type : [props[key].type];
    assert.ok(types.indexOf('null') === -1, key + ' 不接受 null');
  });
  assert.deepStrictEqual(def.inputSchema.required.slice().sort(), ['idempotencyKey', 'title', 'type']);
  assert.strictEqual(props.tags.items.type, 'string');
  assert.strictEqual(props.ownerId.pattern, props.assigneeId.pattern);
  // 受控值域：priority 有已知 enum（不含 null）；releaseMethod 不自創 enum
  assert.ok(def.inputSchema.properties.priority.enum.indexOf('P1-高') !== -1);
  assert.strictEqual(props.releaseMethod.enum, undefined);

  // 建單不收的三樣東西不得出現在 schema
  ['status', 'parentId', 'expectedUpdatedAt'].forEach(function (key) {
    assert.strictEqual(props[key], undefined, 'createTicket 不該有 ' + key);
  });

  // 舊的「請寫進 description / 建單後再補」指引必須消失
  const advice = [def.description]
    .concat(CREATE_OPTIONAL_FIELDS.map(function (k) { return props[k].description; }))
    .join('\n');
  assert.ok(advice.indexOf('尚未確認') === -1, '不得再宣稱欄位名未確認');
  assert.ok(!/寫進 description/.test(advice), '不得再叫人把欄位寫進 description');
});

test('addComment 送 POST /tickets/{ticketId}/comments，body 是 { body, mentions }', async function () {
  const fetchImpl = okFetch({ id: UUID3 });
  await callTool('litejira.addComment', {
    ticketId: 'BUG-481', body: '已修正', mentions: [UUID2], idempotencyKey: KEY
  }, cfg(), fetchImpl);

  const call = fetchImpl.calls[0];
  assert.strictEqual(call.init.method, 'POST');
  assert.strictEqual(call.url, V1 + '/tickets/BUG-481/comments');
  assert.deepStrictEqual(JSON.parse(call.init.body), { body: '已修正', mentions: [UUID2] });
});

test('addComment：舊的 content / transition / expectedUpdatedAt 被拒絕並指路，零請求', async function () {
  const fetchImpl = neverFetch();
  const cases = [
    [{ content: '已修正' }, /body/],
    [{ body: 'x', transition: { toStatus: '完成' } }, /transitionTicket/],
    [{ body: 'x', toStatus: '完成' }, /transitionTicket/],
    [{ body: 'x', expectedUpdatedAt: '2026-09-11T03:04:05.123456Z' }, /樂觀鎖/]
  ];
  for (const pair of cases) {
    const args = Object.assign({ ticketId: 'BUG-481', idempotencyKey: KEY }, pair[0]);
    const response = await rpc('tools/call', { name: 'litejira.addComment', arguments: args }, cfg(), fetchImpl);
    assert.strictEqual(response.error.data.code, 'VALIDATION_FAILED', JSON.stringify(pair[0]));
    assert.match(response.error.message, pair[1]);
  }
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test('attachLink 送 POST /tickets/{ticketId}/attachments，只帶 { url, name }', async function () {
  const fetchImpl = okFetch({ id: UUID3, url: 'https://example.com/a.png' }, 201);
  const result = await callTool('litejira.attachLink', {
    ticketId: UUID, url: 'https://example.com/a.png', name: '截圖', idempotencyKey: KEY
  }, cfg(), fetchImpl);

  const call = fetchImpl.calls[0];
  assert.strictEqual(call.init.method, 'POST');
  assert.strictEqual(call.url, V1 + '/tickets/' + UUID + '/attachments');
  assert.deepStrictEqual(JSON.parse(call.init.body), { url: 'https://example.com/a.png', name: '截圖' });
  // 201 也是 { data } 信封，照樣拆一層
  assert.strictEqual(result.structuredContent.id, UUID3);
});

test('attachLink：非 http(s) URL 在送出前擋下（零請求）', async function () {
  const fetchImpl = neverFetch();
  const response = await rpc('tools/call', {
    name: 'litejira.attachLink',
    arguments: { ticketId: 'BUG-481', url: 'file:///etc/passwd', idempotencyKey: KEY }
  }, cfg(), fetchImpl);
  assert.strictEqual(response.error.data.code, 'invalid_argument');
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test('removeAttachment 送 DELETE /tickets/{ticketId}/attachments/{attachmentId}，無 body，吃 204', async function () {
  const fetchImpl = emptyFetch(204);
  const result = await callTool('litejira.removeAttachment', {
    ticketId: 'BUG-481', attachmentId: UUID3, idempotencyKey: KEY
  }, cfg(), fetchImpl);

  const call = fetchImpl.calls[0];
  assert.strictEqual(call.init.method, 'DELETE');
  assert.strictEqual(call.url, V1 + '/tickets/BUG-481/attachments/' + UUID3);
  assert.strictEqual(call.init.body, undefined, '此端點契約上沒有 body');
  assert.strictEqual(call.init.headers['Idempotency-Key'], KEY);
  // 204 無 body：不編造後端沒說過的內容
  assert.deepStrictEqual(result.structuredContent, { ok: true, status: 204, noContent: true });
});

test('removeAttachment：url 當 id 用會被拒絕；attachmentId 非 UUID 也擋下（零請求）', async function () {
  const fetchImpl = neverFetch();
  const byUrl = await rpc('tools/call', {
    name: 'litejira.removeAttachment',
    arguments: { ticketId: 'BUG-481', url: 'https://example.com/a.png', idempotencyKey: KEY }
  }, cfg(), fetchImpl);
  assert.strictEqual(byUrl.error.data.code, 'VALIDATION_FAILED');
  assert.match(byUrl.error.message, /attachmentId/);

  const badId = await rpc('tools/call', {
    name: 'litejira.removeAttachment',
    arguments: { ticketId: 'BUG-481', attachmentId: 'https://example.com/a.png', idempotencyKey: KEY }
  }, cfg(), fetchImpl);
  assert.strictEqual(badId.error.data.code, 'VALIDATION_FAILED');
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test('linkTickets 送 PUT /tickets/{childId}/parent；null 解除；公開 key 當 parent 被擋', async function () {
  const fetchImpl = okFetch({ id: UUID, parentId: UUID2 });
  await callTool('litejira.linkTickets', {
    childId: '481', parentId: UUID2,
    expectedUpdatedAt: '2026-09-11T03:04:05.123456Z', idempotencyKey: KEY
  }, cfg(), fetchImpl);
  assert.strictEqual(fetchImpl.calls[0].init.method, 'PUT');
  assert.strictEqual(fetchImpl.calls[0].url, V1 + '/tickets/481/parent');
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].init.body), {
    parentId: UUID2, expectedUpdatedAt: '2026-09-11T03:04:05.123456Z'
  });

  const unlink = okFetch({ id: UUID, parentId: null });
  await callTool('litejira.linkTickets',
    { childId: 'BUG-481', parentId: null, idempotencyKey: KEY }, cfg(), unlink);
  assert.deepStrictEqual(JSON.parse(unlink.calls[0].init.body), { parentId: null });

  const never = neverFetch();
  const bad = await rpc('tools/call', {
    name: 'litejira.linkTickets',
    arguments: { childId: 'BUG-481', parentId: 'EPIC-9', idempotencyKey: KEY }
  }, cfg(), never);
  assert.strictEqual(bad.error.data.code, 'VALIDATION_FAILED');
  assert.strictEqual(never.calls.length, 0);
});

test('reassignTicket 送 PUT /tickets/{ticketId}/assignee，assigneeId 收 UUID、reason 必填', async function () {
  const fetchImpl = okFetch({ id: UUID, assignee: { id: UUID2, name: '思源' } });
  await callTool('litejira.reassignTicket', {
    ticketId: 'BUG-481', assigneeId: UUID2, reason: '原處理人休假',
    expectedUpdatedAt: '2026-09-11T03:04:05.123456Z', idempotencyKey: KEY
  }, cfg(), fetchImpl);

  const call = fetchImpl.calls[0];
  assert.strictEqual(call.init.method, 'PUT');
  assert.strictEqual(call.url, V1 + '/tickets/BUG-481/assignee');
  assert.deepStrictEqual(JSON.parse(call.init.body), {
    assigneeId: UUID2, reason: '原處理人休假', expectedUpdatedAt: '2026-09-11T03:04:05.123456Z'
  });

  const never = neverFetch();
  const noReason = await rpc('tools/call', {
    name: 'litejira.reassignTicket',
    arguments: { ticketId: 'BUG-481', assigneeId: UUID2, idempotencyKey: KEY }
  }, cfg(), never);
  assert.strictEqual(noReason.error.data.code, 'VALIDATION_FAILED');
  assert.match(noReason.error.message, /reason/);

  const byName = await rpc('tools/call', {
    name: 'litejira.reassignTicket',
    arguments: { ticketId: 'BUG-481', newAssignee: '思源', reason: 'x', idempotencyKey: KEY }
  }, cfg(), never);
  assert.match(byName.error.message, /assigneeId/);
  assert.strictEqual(never.calls.length, 0);
});

test('convertTicketType 送 POST /tickets/{ticketId}/type，參數名是 type；IDEA/STD 不能當目標', async function () {
  const fetchImpl = okFetch({ id: UUID, type: 'REQ' });
  await callTool('litejira.convertTicketType', {
    ticketId: 'BUG-481', type: 'REQ', subtype: '功能調整', idempotencyKey: KEY
  }, cfg(), fetchImpl);

  const call = fetchImpl.calls[0];
  assert.strictEqual(call.init.method, 'POST');
  assert.strictEqual(call.url, V1 + '/tickets/BUG-481/type');
  assert.deepStrictEqual(JSON.parse(call.init.body), { type: 'REQ', subtype: '功能調整' });

  const never = neverFetch();
  for (const bad of ['IDEA', 'STD']) {
    const response = await rpc('tools/call', {
      name: 'litejira.convertTicketType',
      arguments: { ticketId: 'BUG-481', type: bad, idempotencyKey: KEY }
    }, cfg(), never);
    assert.strictEqual(response.error.data.code, 'VALIDATION_FAILED', bad);
  }
  assert.strictEqual(never.calls.length, 0);
});

test('toggleWatch 依 watching 決定 PUT / DELETE watchers/me，回 { data } 信封', async function () {
  const on = okFetch({ watching: true });
  const onResult = await callTool('litejira.toggleWatch',
    { ticketId: 'BUG-481', watching: true, idempotencyKey: KEY }, cfg(), on);
  assert.strictEqual(on.calls[0].init.method, 'PUT');
  assert.strictEqual(on.calls[0].url, V1 + '/tickets/BUG-481/watchers/me');
  assert.strictEqual(on.calls[0].init.body, undefined);
  // 關注端點回的是資料信封，不是 204：拆一層後原樣回傳，不編造 noContent
  assert.deepStrictEqual(onResult.structuredContent, { watching: true });
  assert.strictEqual(onResult.structuredContent.noContent, undefined);

  const off = okFetch({ watching: false });
  const offResult = await callTool('litejira.toggleWatch',
    { ticketId: 'BUG-481', watching: false, idempotencyKey: KEY }, cfg(), off);
  assert.strictEqual(off.calls[0].init.method, 'DELETE');
  assert.strictEqual(off.calls[0].init.body, undefined);
  assert.deepStrictEqual(offResult.structuredContent, { watching: false });

  // 不講要的結果 = 不送出（toggle 重試會翻回去，不是冪等操作）
  const never = neverFetch();
  const response = await rpc('tools/call', {
    name: 'litejira.toggleWatch',
    arguments: { ticketId: 'BUG-481', idempotencyKey: KEY }
  }, cfg(), never);
  assert.strictEqual(response.error.data.code, 'VALIDATION_FAILED');
  assert.match(response.error.message, /watching/);
  assert.strictEqual(never.calls.length, 0);
});

test('transitionTicket 送 POST /tickets/{ticketId}/transitions，只收動作標籤', async function () {
  const fetchImpl = okFetch({ id: UUID, status: '開發中' });
  await callTool('litejira.transitionTicket', {
    ticketId: 'BUG-481', action: '開始開發', reason: '排進本迭代',
    fields: { fixMethod: '改判定' },
    expectedUpdatedAt: '2026-09-11T03:04:05.123456Z', idempotencyKey: KEY
  }, cfg(), fetchImpl);

  const call = fetchImpl.calls[0];
  assert.strictEqual(call.init.method, 'POST');
  assert.strictEqual(call.url, V1 + '/tickets/BUG-481/transitions');
  assert.deepStrictEqual(JSON.parse(call.init.body), {
    action: '開始開發', reason: '排進本迭代',
    fields: { fixMethod: '改判定' },
    expectedUpdatedAt: '2026-09-11T03:04:05.123456Z'
  });
});

test('transitionTicket：toStatus / extraFields 明確拒絕並指路，零請求', async function () {
  const never = neverFetch();
  const cases = [
    [{ toStatus: '開發中' }, /action/],
    [{ action: '開始開發', extraFields: { fixMethod: 'x' } }, /fields/]
  ];
  for (const pair of cases) {
    const args = Object.assign({ ticketId: 'BUG-481', idempotencyKey: KEY }, pair[0]);
    const response = await rpc('tools/call', { name: 'litejira.transitionTicket', arguments: args }, cfg(), never);
    assert.strictEqual(response.error.data.code, 'VALIDATION_FAILED', JSON.stringify(pair[0]));
    assert.match(response.error.message, pair[1]);
  }
  assert.strictEqual(never.calls.length, 0);
});

// ── 跨工具的共同紀律 ──

test('expectedUpdatedAt 只收原始 ISO 字串：毫秒數字在送出前就被擋下', async function () {
  const never = neverFetch();
  const response = await rpc('tools/call', {
    name: 'litejira.reassignTicket',
    arguments: {
      ticketId: 'BUG-481', assigneeId: UUID2, reason: 'x',
      expectedUpdatedAt: 1789000000000, idempotencyKey: KEY
    }
  }, cfg(), never);
  assert.strictEqual(response.error.data.code, 'VALIDATION_FAILED');
  assert.match(response.error.message, /expectedUpdatedAt/);
  assert.strictEqual(never.calls.length, 0);
});

test('缺 idempotencyKey 或格式不合的 key，一發請求都不送', async function () {
  const never = neverFetch();
  const missing = await rpc('tools/call', {
    name: 'litejira.addComment', arguments: { ticketId: 'BUG-481', body: 'x' }
  }, cfg(), never);
  assert.strictEqual(missing.error.data.code, 'VALIDATION_FAILED');
  assert.match(missing.error.message, /idempotencyKey/);

  const tooShort = await rpc('tools/call', {
    name: 'litejira.addComment', arguments: { ticketId: 'BUG-481', body: 'x', idempotencyKey: 'short' }
  }, cfg(), never);
  assert.strictEqual(tooShort.error.data.code, 'VALIDATION_FAILED');
  assert.strictEqual(never.calls.length, 0);
});

test('關注端點回意外的 204 視為違約：只有刪附件才是 204 端點', async function () {
  for (const watching of [true, false]) {
    const sneaky = emptyFetch(204);
    const result = await callTool('litejira.toggleWatch',
      { ticketId: 'BUG-481', watching: watching, idempotencyKey: KEY }, cfg(), sneaky)
      .then(function (r) { return { ok: r }; }, function (err) { return { err: err }; });
    assert.ok(result.err, 'watching=' + watching + ' 的 204 應該被視為違約');
    assert.strictEqual(result.err.code, 'invalid_response');
  }

  // 同一支路由在傳輸層也不得被當成 emptyBody 放行
  const { ACTION_MAP } = require('../litejira-v1-transport');
  assert.ok(!ACTION_MAP.setWatchState.emptyBody, 'setWatchState 不是 204 端點');
  assert.strictEqual(ACTION_MAP.removeAttachment.emptyBody, true, '唯一的 204 端點是刪附件');
  const emptyBodyRoutes = Object.keys(ACTION_MAP).filter(function (name) {
    return !!ACTION_MAP[name].emptyBody;
  });
  assert.deepStrictEqual(emptyBodyRoutes, ['removeAttachment']);
});

test('204 只在明確無 body 的端點放行：其他端點的空回應不得悄悄當成功', async function () {
  const sneaky = emptyFetch(204);
  const result = await callTool('litejira.addComment',
    { ticketId: 'BUG-481', body: 'x', idempotencyKey: KEY }, cfg(), sneaky)
    .then(function (r) { return { ok: r }; }, function (err) { return { err: err }; });
  assert.ok(result.err, '留言端點回 204 應該視為違約');
  assert.strictEqual(result.err.code, 'invalid_response');

  // 空 body 的 200 一樣不放行
  const empty200 = emptyFetch(200);
  const r2 = await callTool('litejira.attachLink',
    { ticketId: 'BUG-481', url: 'https://example.com/a.png', idempotencyKey: KEY }, cfg(), empty200)
    .then(function (r) { return { ok: r }; }, function (err) { return { err: err }; });
  assert.strictEqual(r2.err.code, 'invalid_response');
});

test('寫入的後端業務錯誤原樣轉出（code / message / details 不重新編碼）', async function () {
  const fetchImpl = errFetch(409, {
    code: 'version_conflict',
    message: '工單已被他人更新',
    details: { currentUpdatedAt: '2026-09-11T04:00:00.000001Z' }
  });
  const result = await callTool('litejira.transitionTicket',
    { ticketId: 'BUG-481', action: '開始開發', idempotencyKey: KEY }, cfg(), fetchImpl);

  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.structuredContent.error.code, 'version_conflict');
  assert.strictEqual(result.structuredContent.error.status, 409);
  assert.deepStrictEqual(result.structuredContent.error.details,
    { currentUpdatedAt: '2026-09-11T04:00:00.000001Z' });
});

test('寫入遇到 redirect 不跟隨（避免 Bearer 外洩到未驗證的目的地）', async function () {
  const fetchImpl = emptyFetch(302);
  const result = await callTool('litejira.addComment',
    { ticketId: 'BUG-481', body: 'x', idempotencyKey: KEY }, cfg(), fetchImpl)
    .then(function (r) { return { ok: r }; }, function (err) { return { err: err }; });

  assert.strictEqual(result.err.code, 'redirect_blocked');
  assert.strictEqual(fetchImpl.calls.length, 1, '不得跟著跳第二發');
  assert.strictEqual(fetchImpl.calls[0].init.redirect, 'manual');
});

test('寫入不自動重試：後端 500 也只送一發，交由呼叫端用同一把 key 重送', async function () {
  const fetchImpl = errFetch(500, { code: 'internal', message: '後端錯誤' });
  const result = await callTool('litejira.createTicket',
    { type: 'BUG', title: 'x', idempotencyKey: KEY }, cfg(), fetchImpl);
  assert.strictEqual(result.isError, true);
  assert.strictEqual(fetchImpl.calls.length, 1);
});

// replyFeedback 是「可選流轉 + 留言」的複合操作，但不是原子操作：舊後端（Code.js:3153）
// 先做可選流轉、再 addComment，本來就是兩個操作。第四包把它做成 client 端複合
// （每步一把穩定且互不相同的冪等鍵 ＋ 明確的部分成功回報），細節見 pack4 測試。
// 這裡守住的是「addComment 自己不會偷偷夾帶流轉」這條界線。
test('addComment 不夾帶流轉：複合是 replyFeedback 的事，不是留言端點的事', async function () {
  const never = neverFetch();
  const response = await rpc('tools/call', {
    name: 'litejira.addComment',
    arguments: { ticketId: 'BUG-481', body: 'x', transition: { action: '開始開發' }, idempotencyKey: KEY }
  }, cfg(), never);
  assert.strictEqual(response.error.data.code, 'VALIDATION_FAILED');
  assert.match(response.error.message, /transitionTicket/);
  assert.strictEqual(never.calls.length, 0);
});

test('傳輸層把 replyFeedback 當「必須拆成兩發的複合操作」，不是「已被取代」', function () {
  const { COMPOSITE_ACTIONS, REPLACED_ACTIONS } = require('../litejira-v1-transport');
  assert.ok(Object.prototype.hasOwnProperty.call(COMPOSITE_ACTIONS, 'replyFeedback'));
  assert.strictEqual(Object.prototype.hasOwnProperty.call(REPLACED_ACTIONS, 'replyFeedback'), false);

  assert.throws(function () {
    buildRequest({
      baseUrl: BASE, token: TOKEN, action: 'replyFeedback', idempotencyKey: KEY,
      params: { ticketId: 'BUG-481', content: 'x' }
    });
  }, function (err) {
    // 傳輸層只送單發：複合要由 MCP 那層拆成 transitionTicket + addComment 兩步。
    return err instanceof LiteJiraTransportError && err.code === 'composite_action' &&
      /transitionTicket/.test(err.message);
  });
});

// ── 傳輸層：MCP 打不到、但契約上必須守住的邊界 ──

test('無 body 契約的寫入路由，多餘參數不會被靜默吞掉', function () {
  assert.throws(function () {
    buildRequest({
      baseUrl: BASE, token: TOKEN, action: 'removeAttachment', idempotencyKey: KEY,
      params: { ticketId: 'BUG-481', attachmentId: UUID3, reason: '誤附' }
    });
  }, function (err) {
    return err instanceof LiteJiraTransportError && err.code === 'invalid_argument' && /reason/.test(err.message);
  });
});

test('setWatchState 必須明講 watching 布林，不接受 toggle 語意', function () {
  [undefined, 'true', 1].forEach(function (bad) {
    assert.throws(function () {
      buildRequest({
        baseUrl: BASE, token: TOKEN, action: 'setWatchState', idempotencyKey: KEY,
        params: { ticketId: 'BUG-481', watching: bad }
      });
    }, function (err) {
      return err instanceof LiteJiraTransportError && err.code === 'invalid_argument';
    }, String(bad));
  });

  // 布林本身不進 body：它只決定動詞
  const on = buildRequest({
    baseUrl: BASE, token: TOKEN, action: 'setWatchState', idempotencyKey: KEY,
    params: { ticketId: 'BUG-481', watching: true }
  });
  assert.strictEqual(on.method, 'PUT');
  assert.strictEqual(on.body, undefined);
  assert.strictEqual(on.headers['Content-Type'], undefined);
});

test('toggleWatchTicket 是被取代的 action，指路到 setWatchState', function () {
  assert.throws(function () {
    buildRequest({ baseUrl: BASE, token: TOKEN, action: 'toggleWatchTicket', idempotencyKey: KEY, params: {} });
  }, function (err) {
    return err instanceof LiteJiraTransportError && err.code === 'replaced_action' && /setWatchState/.test(err.message);
  });
});

test('宣告 204 無 body 的端點若真的回了 body，視為違約而不是照單全收', async function () {
  const withBody = recorder(JSON.stringify({ data: { removed: true } }), 204);
  await assert.rejects(
    callV1({
      fetch: withBody, baseUrl: BASE, token: TOKEN, action: 'removeAttachment', idempotencyKey: KEY,
      params: { ticketId: 'BUG-481', attachmentId: UUID3 }
    }),
    function (err) {
      return err instanceof LiteJiraTransportError && err.code === 'invalid_response';
    }
  );
});

test('expectedUpdatedAt 傳毫秒數字時，傳輸層也會擋（訊息講明會撞假衝突）', function () {
  assert.throws(function () {
    buildRequest({
      baseUrl: BASE, token: TOKEN, action: 'linkTickets', idempotencyKey: KEY,
      params: { childId: 'BUG-481', parentId: UUID, expectedUpdatedAt: 1789000000000 }
    });
  }, function (err) {
    return err instanceof LiteJiraTransportError && err.code === 'invalid_argument' && /精度/.test(err.message);
  });
});

test('第四包後：三個 batch 有自己的路由，兩個複合 action 明確要求拆步驟', function () {
  const { ACTION_MAP } = require('../litejira-v1-transport');
  ['batchTransition', 'batchReassign', 'batchSetField'].forEach(function (action) {
    assert.ok(ACTION_MAP[action], action + ' 應該有 v1 路由');
  });
  ['replyFeedback', 'updateField'].forEach(function (action) {
    assert.throws(function () {
      buildRequest({ baseUrl: BASE, token: TOKEN, action: action, idempotencyKey: KEY, params: {} });
    }, function (err) {
      return err instanceof LiteJiraTransportError && err.code === 'composite_action';
    }, action);
  });
});

// ── helpers ──

function cfg(extra) {
  return Object.assign({
    apiUrl: BASE,
    token: TOKEN,
    project: 'LTJ',
    enableWrites: true
  }, extra || {});
}

function recorder(bodyText, status) {
  const calls = [];
  const fetchImpl = function (url, init) {
    calls.push({ url: url, init: init });
    return Promise.resolve({
      status: status || 200,
      text: function () { return Promise.resolve(bodyText); }
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function okFetch(data, status) {
  return recorder(JSON.stringify({ data: data }), status);
}

function errFetch(status, error) {
  return recorder(JSON.stringify({ error: error }), status);
}

// 真正的空 body（204 / 錯誤的空 200 / redirect 都走這條）
function emptyFetch(status) {
  return recorder('', status);
}

function neverFetch() {
  const fetchImpl = function () {
    throw new Error('不應該送出任何請求');
  };
  fetchImpl.calls = [];
  return fetchImpl;
}

function rpc(method, params, config, fetchImpl) {
  return handleJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: method, params: params }, config, fetchImpl);
}
