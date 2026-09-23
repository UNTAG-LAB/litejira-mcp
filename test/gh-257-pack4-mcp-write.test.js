'use strict';

// GH-257 第四包：最後 5 個工具接上 API v1
//（updateField / replyFeedback / batchTransition / batchReassign / batchSetField）。
// 全部測試注入假 fetch，走真正的 JSON-RPC handler / callTool，不接觸真 API、不讀憑證。
// 驗的是「真的送出什麼」：method / URL / header / body、分流有沒有走對端點，
// 以及「什麼情況一發都不送」「失敗時有沒有誠實回報部分成功」。

const test = require('node:test');
const assert = require('node:assert');

const {
  callTool,
  handleJsonRpcRequest,
  listTools
} = require('../litejira-mcp-server');
const {
  LiteJiraTransportError,
  buildRequest
} = require('../litejira-v1-transport');

const BASE = 'https://litejira.example.com';
const V1 = BASE + '/api/v1';
const TOKEN = 'ltj_pat_test_abcdefgh';
const KEY = 'idem_key_0123456789';
const KEY2 = 'idem_key_9876543210';
const UUID = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';
const UUID2 = '8a7b6c5d-4e3f-4a2b-9c8d-7e6f5a4b3c2d';
const UUID3 = '11112222-3333-4444-5555-666677778888';
const ISO = '2026-09-11T03:22:10.123456Z';

// 本包接線的 5 個工具（最小合法參數）。
const PACK4_TOOLS = [
  ['litejira.updateField', { ticketId: 'BUG-481', field: 'dueDate', value: '2026-09-30' }],
  ['litejira.replyFeedback', { ticketId: 'BUG-481', content: '已修正' }],
  ['litejira.batchTransition', { tickets: ['BUG-481'], action: '開始開發' }],
  ['litejira.batchReassign', { tickets: ['BUG-481'], assigneeId: UUID2, reason: '換人接手' }],
  ['litejira.batchSetField', { tickets: ['BUG-481'], field: 'priority', value: 'P1-高' }]
];

// ── tools/list：20 個工具全部公告，沒有任何 pending ──
// （GH-317 起多了 getAttachments / uploadAttachment 兩支附件工具。）

test('tools/list 回全部 20 個工具，第四包的 5 個都在', async function () {
  const names = listTools().map(function (t) { return t.name; }).sort();
  assert.deepStrictEqual(names, [
    'litejira.addComment',
    'litejira.attachLink',
    'litejira.batchReassign',
    'litejira.batchSetField',
    'litejira.batchTransition',
    'litejira.convertTicketType',
    'litejira.createTicket',
    'litejira.getActivityLog',
    'litejira.getAttachments',
    'litejira.getTransitions',
    'litejira.linkTickets',
    'litejira.listComments',
    'litejira.reassignTicket',
    'litejira.removeAttachment',
    'litejira.replyFeedback',
    'litejira.searchTickets',
    'litejira.toggleWatch',
    'litejira.transitionTicket',
    'litejira.updateField',
    'litejira.uploadAttachment'
  ]);
  assert.strictEqual(names.length, 20);
});

test('第四包的 5 個工具都要求 idempotencyKey，且不再宣稱未接線', async function () {
  const listed = listTools();
  PACK4_TOOLS.forEach(function (pair) {
    const def = listed.find(function (t) { return t.name === pair[0]; });
    assert.ok(def, pair[0] + ' 應該出現在 tools/list');
    assert.ok(def.inputSchema.required.indexOf('idempotencyKey') !== -1, pair[0] + ' 必須要求 idempotencyKey');
    assert.ok(!/not available|NOT wired|尚未接/.test(def.description), pair[0] + ' 說明不得再宣稱未接線');
  });
});

test('第四包的 schema 對齊 v1 契約參數名（批次用 tickets，不是 ids）', async function () {
  const byName = {};
  listTools().forEach(function (t) { byName[t.name] = t.inputSchema; });

  ['litejira.batchTransition', 'litejira.batchReassign', 'litejira.batchSetField'].forEach(function (name) {
    assert.ok(byName[name].properties.tickets, name + ' 應該收 tickets');
    assert.strictEqual(byName[name].properties.ids, undefined, name + ' 不該再有 ids');
    assert.strictEqual(byName[name].properties.expectedUpdatedAt, undefined, name + ' 批次不做樂觀鎖');
    assert.strictEqual(byName[name].properties.tickets.maxItems, 100);
    assert.strictEqual(byName[name].properties.tickets.minItems, 1);
  });
  assert.ok(byName['litejira.batchReassign'].properties.assigneeId);
  assert.strictEqual(byName['litejira.batchReassign'].properties.newAssignee, undefined);
  assert.ok(byName['litejira.batchTransition'].properties.fields);
  assert.strictEqual(byName['litejira.batchTransition'].properties.extraFields, undefined);

  // updateField / batchSetField 的白名單是 v1 欄位名：舊名一律不在 enum 內
  const single = byName['litejira.updateField'].properties.field.enum;
  ['verifyMethod', 'owner', 'assignee', 'version', 'notes'].forEach(function (old) {
    assert.ok(single.indexOf(old) === -1, 'updateField 不該保留舊欄位名 ' + old);
  });
  ['title', 'ownerId', 'assigneeId', 'parentId', 'targetVersion', 'foundVersion', 'status', 'validationMethod']
    .forEach(function (key) {
      assert.ok(single.indexOf(key) !== -1, 'updateField 缺欄位 ' + key);
    });

  const batch = byName['litejira.batchSetField'].properties.field.enum;
  assert.ok(batch.indexOf('status') === -1, 'status 不是批次欄位');
  ['priority', 'module', 'parentId', 'targetVersion', 'foundVersion'].forEach(function (key) {
    assert.ok(batch.indexOf(key) !== -1, 'batchSetField 缺欄位 ' + key);
  });

  // value 必須收得下陣列（tags）與 null（清空）
  ['litejira.updateField', 'litejira.batchSetField'].forEach(function (name) {
    const types = byName[name].properties.value.type;
    assert.ok(types.indexOf('null') !== -1, name + ' 的 value 要收 null');
    assert.ok(types.indexOf('array') !== -1, name + ' 的 value 要收陣列');
    // value 不能列進 required：required 檢查會把合法的空字串當成缺值
    assert.ok(byName[name].required.indexOf('value') === -1, name + ' 的 value 不該進 required');
  });

  // replyFeedback 的流轉是巢狀物件，且工單參照放寬成三形狀
  assert.strictEqual(byName['litejira.replyFeedback'].properties.transition.type, 'object');
  assert.match(byName['litejira.updateField'].properties.ticketId.pattern, /0-9a-fA-F/);
});

// ── 寫入開關：關閉時一發都不送 ──

test('LTJ_MCP_ENABLE_WRITES 未開時，第四包 5 個工具全部被擋且不送出任何請求', async function () {
  const fetchImpl = neverFetch();
  for (const pair of PACK4_TOOLS) {
    const args = Object.assign({ idempotencyKey: KEY }, pair[1]);
    const response = await rpc('tools/call', { name: pair[0], arguments: args },
      cfg({ enableWrites: false }), fetchImpl);
    assert.ok(response.error, pair[0] + ' 應該被擋下');
    assert.strictEqual(response.error.data.code, 'WRITES_DISABLED', pair[0]);
  }
  assert.strictEqual(fetchImpl.calls.length, 0);
});

// ── updateField：一個工具、五條路 ──

test('updateField 一般欄位走 PATCH /tickets/{ref}，body 是平攤的單一欄位', async function () {
  const fetchImpl = okFetch({ id: UUID, key: 'BUG-481' });
  const result = await callTool('litejira.updateField', {
    ticketId: 'BUG-481', field: 'dueDate', value: '2026-09-30',
    expectedUpdatedAt: ISO, idempotencyKey: KEY
  }, cfg(), fetchImpl);

  assert.strictEqual(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.strictEqual(call.init.method, 'PATCH');
  assert.strictEqual(call.url, V1 + '/tickets/BUG-481');
  assert.strictEqual(call.init.headers['Idempotency-Key'], KEY);
  assert.deepStrictEqual(JSON.parse(call.init.body), { dueDate: '2026-09-30', expectedUpdatedAt: ISO });
  assert.ok(call.init.body.indexOf(KEY) === -1, '冪等鍵不得進 body');
  assert.deepStrictEqual(result.structuredContent, { id: UUID, key: 'BUG-481' });
});

test('updateField 一般欄位：tags 收陣列、null 清空（含 priority）、文字欄位收空字串', async function () {
  const cases = [
    ['tags', ['登入', '逾時']],
    ['priority', null],
    ['ownerId', null],
    ['description', ''],
    ['validationMethod', '手動驗證'],
    ['ownerId', UUID2],
    ['startDate', '2026-09-14']
  ];
  for (const pair of cases) {
    const fetchImpl = okFetch({ id: UUID });
    await callTool('litejira.updateField', {
      ticketId: UUID, field: pair[0], value: pair[1], idempotencyKey: KEY
    }, cfg(), fetchImpl);
    const sent = JSON.parse(fetchImpl.calls[0].init.body);
    assert.deepStrictEqual(sent[pair[0]], pair[1], pair[0] + ' 應原樣送出');
    assert.strictEqual(Object.keys(sent).length, 1, pair[0] + '：一次只改一個欄位');
  }
});

test('updateField：title 不接受空字串，也不接受 null（清掉標題不是合法操作）', async function () {
  for (const bad of ['', null]) {
    const fetchImpl = neverFetch();
    await assert.rejects(
      callTool('litejira.updateField',
        { ticketId: 'BUG-481', field: 'title', value: bad, idempotencyKey: KEY }, cfg(), fetchImpl),
      function (err) { return err.code === 'invalid_argument'; },
      'title=' + JSON.stringify(bad)
    );
    assert.strictEqual(fetchImpl.calls.length, 0);
  }
});

test('updateField：value 完全沒帶時本機拒絕（不把「沒帶」當成清空）', async function () {
  const fetchImpl = neverFetch();
  await assert.rejects(
    callTool('litejira.updateField',
      { ticketId: 'BUG-481', field: 'module', idempotencyKey: KEY }, cfg(), fetchImpl),
    function (err) {
      assert.strictEqual(err.code, 'VALIDATION_FAILED');
      assert.match(err.message, /value/);
      return true;
    }
  );
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test('updateField field=parentId 走 PUT /parent（UUID 或 null），不收 reason', async function () {
  const fetchImpl = okFetch({ id: UUID });
  await callTool('litejira.updateField', {
    ticketId: 'BUG-481', field: 'parentId', value: UUID3, expectedUpdatedAt: ISO, idempotencyKey: KEY
  }, cfg(), fetchImpl);
  assert.strictEqual(fetchImpl.calls[0].init.method, 'PUT');
  assert.strictEqual(fetchImpl.calls[0].url, V1 + '/tickets/BUG-481/parent');
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].init.body),
    { parentId: UUID3, expectedUpdatedAt: ISO });

  const unlink = okFetch({ id: UUID });
  await callTool('litejira.updateField',
    { ticketId: 'BUG-481', field: 'parentId', value: null, idempotencyKey: KEY }, cfg(), unlink);
  assert.deepStrictEqual(JSON.parse(unlink.calls[0].init.body), { parentId: null });

  // 公開 key 當父工單：單張的 parent 端點只收 UUID，本機就擋下
  const never = neverFetch();
  await assert.rejects(
    callTool('litejira.updateField',
      { ticketId: 'BUG-481', field: 'parentId', value: 'EPIC-12', idempotencyKey: KEY }, cfg(), never),
    function (err) { return err.code === 'invalid_argument' && /UUID/.test(err.message); }
  );
  assert.strictEqual(never.calls.length, 0);
});

test('updateField field=assigneeId 走 PUT /assignee，reason 必填且 null 不可清空', async function () {
  const fetchImpl = okFetch({ id: UUID });
  await callTool('litejira.updateField', {
    ticketId: 'BUG-481', field: 'assigneeId', value: UUID2, reason: '換人接手', idempotencyKey: KEY
  }, cfg(), fetchImpl);
  assert.strictEqual(fetchImpl.calls[0].url, V1 + '/tickets/BUG-481/assignee');
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].init.body),
    { assigneeId: UUID2, reason: '換人接手' });

  const never = neverFetch();
  await assert.rejects(
    callTool('litejira.updateField',
      { ticketId: 'BUG-481', field: 'assigneeId', value: UUID2, idempotencyKey: KEY }, cfg(), never),
    function (err) {
      assert.strictEqual(err.code, 'VALIDATION_FAILED');
      assert.match(err.message, /reason/);
      return true;
    }
  );
  await assert.rejects(
    callTool('litejira.updateField',
      { ticketId: 'BUG-481', field: 'assigneeId', value: null, reason: 'x', idempotencyKey: KEY }, cfg(), never),
    function (err) { return err.code === 'VALIDATION_FAILED'; }
  );
  assert.strictEqual(never.calls.length, 0);
});

test('updateField 版本欄位走 PUT /versions，收版本 UUID，省略另一個＝保持原值', async function () {
  const target = okFetch({ id: UUID });
  await callTool('litejira.updateField', {
    ticketId: 'BUG-481', field: 'targetVersion', value: UUID3,
    reason: '延到下一版', expectedUpdatedAt: ISO, idempotencyKey: KEY
  }, cfg(), target);
  assert.strictEqual(target.calls[0].init.method, 'PUT');
  assert.strictEqual(target.calls[0].url, V1 + '/tickets/BUG-481/versions');
  assert.deepStrictEqual(JSON.parse(target.calls[0].init.body),
    { targetVersionId: UUID3, reason: '延到下一版', expectedUpdatedAt: ISO });

  const found = okFetch({ id: UUID });
  await callTool('litejira.updateField',
    { ticketId: 'BUG-481', field: 'foundVersion', value: null, idempotencyKey: KEY }, cfg(), found);
  // null ＝ 明確清空，一定要出現在 body（省略是「保持原值」，語意不同）
  assert.deepStrictEqual(JSON.parse(found.calls[0].init.body), { foundVersionId: null });

  // 版本名稱不是 UUID：本機擋下並指路去讀 litejira://versions
  const never = neverFetch();
  await assert.rejects(
    callTool('litejira.updateField',
      { ticketId: 'BUG-481', field: 'targetVersion', value: '1.2.0', idempotencyKey: KEY }, cfg(), never),
    function (err) { return err.code === 'invalid_argument' && /UUID/.test(err.message); }
  );
  assert.strictEqual(never.calls.length, 0);
});

test('updateField field=status 沒有 force=true 一律本機拒絕，並指路 transitionTicket', async function () {
  const never = neverFetch();
  for (const force of [undefined, false]) {
    const args = { ticketId: 'BUG-481', field: 'status', value: '開發中', idempotencyKey: KEY };
    if (force !== undefined) args.force = force;
    const response = await rpc('tools/call', { name: 'litejira.updateField', arguments: args }, cfg(), never);
    assert.strictEqual(response.error.data.code, 'VALIDATION_FAILED', 'force=' + force);
    assert.match(response.error.message, /transitionTicket/);
    assert.match(response.error.message, /getTransitions/);
  }
  assert.strictEqual(never.calls.length, 0, '被擋下的強制改狀態不得送出任何請求');
});

test('updateField field=status + force=true 走 PUT /status，且 force 不進 body', async function () {
  const fetchImpl = okFetch({ id: UUID, status: '開發中' });
  await callTool('litejira.updateField', {
    ticketId: 'BUG-481', field: 'status', value: '開發中', force: true,
    reason: '資料修正', expectedUpdatedAt: ISO, idempotencyKey: KEY
  }, cfg(), fetchImpl);

  assert.strictEqual(fetchImpl.calls[0].init.method, 'PUT');
  assert.strictEqual(fetchImpl.calls[0].url, V1 + '/tickets/BUG-481/status');
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepStrictEqual(sent, { status: '開發中', reason: '資料修正', expectedUpdatedAt: ISO });
  assert.strictEqual(sent.force, undefined, 'force 是本機閘門，不是 body 欄位');
});

test('updateField：force 只給 status 用；其他欄位帶 force 本機拒絕', async function () {
  const never = neverFetch();
  await assert.rejects(
    callTool('litejira.updateField',
      { ticketId: 'BUG-481', field: 'priority', value: 'P0-緊急', force: true, idempotencyKey: KEY }, cfg(), never),
    function (err) {
      assert.strictEqual(err.code, 'VALIDATION_FAILED');
      assert.match(err.message, /force/);
      return true;
    }
  );
  assert.strictEqual(never.calls.length, 0);
});

test('updateField：端點不收 reason 時當面拒絕，不靜默丟掉', async function () {
  const never = neverFetch();
  for (const field of ['priority', 'parentId']) {
    const value = field === 'parentId' ? UUID3 : 'P1-高';
    await assert.rejects(
      callTool('litejira.updateField',
        { ticketId: 'BUG-481', field: field, value: value, reason: '順手寫個原因', idempotencyKey: KEY },
        cfg(), never),
      function (err) {
        assert.strictEqual(err.code, 'VALIDATION_FAILED');
        assert.match(err.message, /reason/);
        return true;
      }, field
    );
  }
  assert.strictEqual(never.calls.length, 0);
});

test('updateField：舊欄位名指路到 v1 的新名，notes 明確說沒有等價欄位', async function () {
  const never = neverFetch();
  const cases = [
    ['verifyMethod', /validationMethod/],
    ['owner', /ownerId/],
    ['assignee', /assigneeId/],
    ['version', /targetVersion/],
    ['notes', /description/]
  ];
  for (const pair of cases) {
    const response = await rpc('tools/call', {
      name: 'litejira.updateField',
      arguments: { ticketId: 'BUG-481', field: pair[0], value: 'x', idempotencyKey: KEY }
    }, cfg(), never);
    assert.strictEqual(response.error.data.code, 'VALIDATION_FAILED', pair[0]);
    assert.match(response.error.message, pair[1], pair[0]);
    // 不得只回一句籠統的型別錯誤
    assert.ok(!/^invalid parameter type/.test(response.error.message), pair[0]);
  }
  // notes 不得被偷偷搬進 description
  assert.strictEqual(never.calls.length, 0);
});

test('updateField：expectedUpdatedAt 傳毫秒數字時，五條路都擋（掉精度會撞假衝突）', async function () {
  const never = neverFetch();
  const routes = [
    { field: 'dueDate', value: '2026-09-30' },
    { field: 'parentId', value: UUID3 },
    { field: 'assigneeId', value: UUID2, reason: 'x' },
    { field: 'targetVersion', value: UUID3 },
    { field: 'status', value: '開發中', force: true }
  ];
  for (const route of routes) {
    const args = Object.assign({ ticketId: 'BUG-481', idempotencyKey: KEY, expectedUpdatedAt: 1789000000000 }, route);
    const response = await rpc('tools/call', { name: 'litejira.updateField', arguments: args }, cfg(), never);
    assert.ok(response.error, route.field);
    // schema 先擋（型別不是 string）或傳輸層擋，都可以；重點是「沒送出」
    assert.strictEqual(never.calls.length, 0, route.field);
  }
});

test('updateField：後端業務錯誤原樣轉出，且不自動重試', async function () {
  const fetchImpl = errFetch(409, { code: 'version_conflict', message: '工單已被他人修改' });
  const result = await callTool('litejira.updateField',
    { ticketId: 'BUG-481', field: 'priority', value: 'P0-緊急', expectedUpdatedAt: ISO, idempotencyKey: KEY },
    cfg(), fetchImpl);
  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.structuredContent.error.code, 'version_conflict');
  assert.strictEqual(fetchImpl.calls.length, 1, '寫入不自動重試');
});

// ── replyFeedback：client 端複合（先流轉、再留言）──

test('replyFeedback 只留言時只送一發 POST /comments，且不夾帶流轉', async function () {
  const fetchImpl = okFetch({ id: UUID3, body: '已修正' });
  const result = await callTool('litejira.replyFeedback',
    { ticketId: 'BUG-481', content: '已修正', idempotencyKey: KEY }, cfg(), fetchImpl);

  assert.strictEqual(fetchImpl.calls.length, 1);
  assert.strictEqual(fetchImpl.calls[0].url, V1 + '/tickets/BUG-481/comments');
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].init.body), { body: '已修正' });
  assert.strictEqual(result.structuredContent.ok, true);
  assert.strictEqual(result.structuredContent.atomic, false);
  assert.deepStrictEqual(result.structuredContent.steps.map(function (s) { return s.step; }), ['comment']);
});

test('replyFeedback 帶 transition 時：先流轉、再留言，兩步的冪等鍵不同且都不是原鍵', async function () {
  const fetchImpl = seqFetch([
    { status: 200, body: { data: { id: UUID, status: '開發中' } } },
    { status: 200, body: { data: { id: UUID3 } } }
  ]);
  const result = await callTool('litejira.replyFeedback', {
    ticketId: 'BUG-481', content: '已修正',
    transition: { action: '開始開發', reason: '接手', fields: { fixMethod: '改設定' } },
    expectedUpdatedAt: ISO, idempotencyKey: KEY
  }, cfg(), fetchImpl);

  assert.strictEqual(fetchImpl.calls.length, 2);
  // 順序：流轉在前、留言在後（舊後端也是這個順序）
  assert.strictEqual(fetchImpl.calls[0].url, V1 + '/tickets/BUG-481/transitions');
  assert.strictEqual(fetchImpl.calls[1].url, V1 + '/tickets/BUG-481/comments');
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].init.body), {
    action: '開始開發', reason: '接手', fields: { fixMethod: '改設定' }, expectedUpdatedAt: ISO
  });
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[1].init.body), { body: '已修正' });

  const keys = fetchImpl.calls.map(function (c) { return c.init.headers['Idempotency-Key']; });
  assert.notStrictEqual(keys[0], keys[1], '兩步的鍵必須互不相同');
  assert.ok(keys.indexOf(KEY) === -1, '每步都用衍生鍵，不直接沿用呼叫端那一把');
  keys.forEach(function (key) {
    assert.match(key, /^[A-Za-z0-9_-]{16,64}$/, '衍生鍵必須符合 Idempotency-Key 格式');
  });
  assert.deepStrictEqual(result.structuredContent.steps.map(function (s) { return s.step; }),
    ['transition', 'comment']);
});

test('replyFeedback 的衍生鍵是「同輸入同鍵」（可重送去重），換 base key 就換一組', async function () {
  async function keysFor(baseKey) {
    const fetchImpl = seqFetch([
      { status: 200, body: { data: {} } },
      { status: 200, body: { data: {} } }
    ]);
    await callTool('litejira.replyFeedback', {
      ticketId: 'BUG-481', content: 'x', transition: { action: '開始開發' }, idempotencyKey: baseKey
    }, cfg(), fetchImpl);
    return fetchImpl.calls.map(function (c) { return c.init.headers['Idempotency-Key']; });
  }
  const first = await keysFor(KEY);
  const again = await keysFor(KEY);
  assert.deepStrictEqual(again, first, '同一把 base key 必須推出同樣的兩把步驟鍵');
  const other = await keysFor(KEY2);
  assert.notStrictEqual(other[0], first[0]);
  assert.notStrictEqual(other[1], first[1]);
});

test('replyFeedback：流轉失敗就停手，留言一發都不送', async function () {
  const fetchImpl = seqFetch([
    { status: 409, body: { error: { code: 'state_conflict', message: '此動作不適用當前狀態' } } }
  ]);
  const result = await callTool('litejira.replyFeedback', {
    ticketId: 'BUG-481', content: '已修正', transition: { action: '結案' }, idempotencyKey: KEY
  }, cfg(), fetchImpl);

  assert.strictEqual(fetchImpl.calls.length, 1, '流轉失敗後不得再送留言');
  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.structuredContent.error.code, 'state_conflict');
  assert.strictEqual(result.structuredContent.partial.failedStep, 'transition');
  assert.deepStrictEqual(result.structuredContent.partial.completed, []);
  assert.match(result.content[0].text, /留言未送出/);
});

test('replyFeedback：流轉成功但留言失敗 → 明確的部分成功回報（不編造 rollback）', async function () {
  const fetchImpl = seqFetch([
    { status: 200, body: { data: { id: UUID, status: '開發中' } } },
    { status: 403, body: { error: { code: 'permission_denied', message: '沒有留言權限' } } }
  ]);
  const result = await callTool('litejira.replyFeedback', {
    ticketId: 'BUG-481', content: '已修正', transition: { action: '開始開發' }, idempotencyKey: KEY
  }, cfg(), fetchImpl);

  assert.strictEqual(fetchImpl.calls.length, 2);
  assert.strictEqual(result.isError, true);
  const partial = result.structuredContent.partial;
  assert.strictEqual(result.structuredContent.error.code, 'permission_denied', '原始錯誤原樣保留');
  assert.deepStrictEqual(partial.completed, ['transition']);
  assert.strictEqual(partial.failedStep, 'comment');
  assert.strictEqual(partial.failedStepApplied, 'no');
  assert.strictEqual(partial.atomic, false);
  assert.strictEqual(partial.steps[0].step, 'transition');
  assert.strictEqual(partial.steps[0].ok, true);
  // 文字訊息要講清楚「流轉已生效」，且不得出現虛構的還原說法
  assert.match(result.content[0].text, /流轉已經生效/);
  assert.ok(!/已還原|rollback|已全部完成/i.test(result.content[0].text));
});

test('replyFeedback：留言步驟連線失敗 → 結果「不確定」，並指示用同一把 key 重送', async function () {
  let calls = 0;
  const fetchImpl = function (url, init) {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve({ status: 200, text: function () { return Promise.resolve('{"data":{}}'); } });
    }
    return Promise.reject(new Error('socket hang up'));
  };
  const result = await callTool('litejira.replyFeedback', {
    ticketId: 'BUG-481', content: '已修正', transition: { action: '開始開發' }, idempotencyKey: KEY
  }, cfg(), fetchImpl);

  assert.strictEqual(calls, 2, '不重試：留言只送一發');
  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.structuredContent.error.code, 'network_error');
  assert.strictEqual(result.structuredContent.partial.failedStepApplied, 'unknown');
  assert.doesNotMatch(result.content[0].text, /留言沒送成|留言沒有生效/);
  assert.match(result.content[0].text, /未取得留言成功回應/);
  assert.match(result.content[0].text, /同一把 idempotencyKey/);
});

test('replyFeedback：後端 5xx 的那一步也算「結果不確定」', async function () {
  const fetchImpl = seqFetch([
    { status: 200, body: { data: {} } },
    { status: 500, body: { error: { code: 'internal', message: '後端錯誤' } } }
  ]);
  const result = await callTool('litejira.replyFeedback', {
    ticketId: 'BUG-481', content: 'x', transition: { action: '開始開發' }, idempotencyKey: KEY
  }, cfg(), fetchImpl);
  assert.strictEqual(fetchImpl.calls.length, 2, '不自動重試');
  assert.strictEqual(result.structuredContent.partial.failedStepApplied, 'unknown');
});

// ── idempotency_key_reused（409）：in_progress 與 request_mismatch 的善後完全不同 ──

function reused(reason) {
  return {
    status: 409,
    body: {
      error: {
        code: 'idempotency_key_reused',
        message: reason === 'in_progress' ? '前一次請求仍在處理中' : '同一把 key 先前配過不同的請求內容',
        details: { reason: reason }
      }
    }
  };
}

test('replyFeedback：第一步撞 in_progress → 結果「不確定」，留言不送，且不得叫人換新 key', async function () {
  const fetchImpl = seqFetch([reused('in_progress')]);
  const result = await callTool('litejira.replyFeedback', {
    ticketId: 'BUG-481', content: '已修正', transition: { action: '開始開發' }, idempotencyKey: KEY
  }, cfg(), fetchImpl);

  assert.strictEqual(fetchImpl.calls.length, 1, '第一步未定案就不得續送留言，也不得自行重試');
  assert.strictEqual(result.isError, true);
  const partial = result.structuredContent.partial;
  assert.strictEqual(result.structuredContent.error.code, 'idempotency_key_reused');
  assert.strictEqual(partial.failedStep, 'transition');
  assert.deepStrictEqual(partial.completed, []);
  assert.strictEqual(partial.idempotencyReuse, 'in_progress');
  // 前一次同 key 的請求還在跑：這一步到底做了沒，這個回應證明不了。
  assert.strictEqual(partial.failedStepApplied, 'unknown');
  assert.strictEqual(partial.priorAttemptApplied, 'unknown');

  const text = result.content[0].text;
  assert.match(text, /不要換一把新 key/);
  assert.ok(!/請換.*key|改用(一把)?新(的)? ?key|換一把新 key 重(送|跑)/.test(text),
    'in_progress 不得建議換新 key');
  assert.match(text, /不要改動輸入|完全相同的輸入/);
  assert.match(text, /24 小時/);
});

test('replyFeedback：留言步驟撞 in_progress → 部分成功 + 結果不確定，指示同 key 同輸入', async function () {
  const fetchImpl = seqFetch([
    { status: 200, body: { data: { id: UUID, status: '開發中' } } },
    reused('in_progress')
  ]);
  const result = await callTool('litejira.replyFeedback', {
    ticketId: 'BUG-481', content: '已修正', transition: { action: '開始開發' }, idempotencyKey: KEY
  }, cfg(), fetchImpl);

  assert.strictEqual(fetchImpl.calls.length, 2, '不自動重試');
  const partial = result.structuredContent.partial;
  assert.deepStrictEqual(partial.completed, ['transition']);
  assert.strictEqual(partial.failedStep, 'comment');
  assert.strictEqual(partial.idempotencyReuse, 'in_progress');
  assert.strictEqual(partial.failedStepApplied, 'unknown');
  assert.strictEqual(partial.priorAttemptApplied, 'unknown');

  const text = result.content[0].text;
  assert.match(text, /流轉已經生效/);
  assert.match(text, /不要換一把新 key/);
  assert.ok(!/已還原|rollback/i.test(text));
});

test('replyFeedback：留言步驟撞 request_mismatch → 這份內容沒受理，但前一次同 key 的結果未證明', async function () {
  const fetchImpl = seqFetch([
    { status: 200, body: { data: { id: UUID, status: '開發中' } } },
    reused('request_mismatch')
  ]);
  const result = await callTool('litejira.replyFeedback', {
    ticketId: 'BUG-481', content: '已修正', transition: { action: '開始開發' }, idempotencyKey: KEY
  }, cfg(), fetchImpl);

  assert.strictEqual(fetchImpl.calls.length, 2, '不自動重試、也不額外去撈狀態');
  const partial = result.structuredContent.partial;
  assert.deepStrictEqual(partial.completed, ['transition'], '先前已完成的流轉照樣列出');
  assert.strictEqual(partial.idempotencyReuse, 'request_mismatch');
  // 被拒的是「這一份內容」；同一把 key 的前一次操作結果不在這個回應的保證範圍內。
  assert.strictEqual(partial.failedStepApplied, 'no');
  assert.strictEqual(partial.priorAttemptApplied, 'unknown');

  const text = result.content[0].text;
  assert.match(text, /並沒有被證明|未被證明/);
  assert.match(text, /不要.*重複送同一份|不要重複送同一份/);
  assert.match(text, /不要換一把新 key/);
  assert.match(text, /還沒做的那一步/);
});

test('replyFeedback：後端沒給 reason 的 idempotency_key_reused 取最保守的 unknown', async function () {
  const fetchImpl = seqFetch([
    { status: 409, body: { error: { code: 'idempotency_key_reused', message: '鍵已被使用' } } }
  ]);
  const result = await callTool('litejira.replyFeedback', {
    ticketId: 'BUG-481', content: 'x', transition: { action: '開始開發' }, idempotencyKey: KEY
  }, cfg(), fetchImpl);
  const partial = result.structuredContent.partial;
  assert.strictEqual(partial.idempotencyReuse, 'unspecified');
  assert.strictEqual(partial.failedStepApplied, 'unknown');
  assert.strictEqual(partial.priorAttemptApplied, 'unknown');
});

test('replyFeedback：結果不確定的指示不承諾「永遠可安全重放」，且不自動重試', async function () {
  const fetchImpl = seqFetch([
    { status: 200, body: { data: {} } },
    { status: 503, body: { error: { code: 'internal', message: '暫時不可用' } } }
  ]);
  const result = await callTool('litejira.replyFeedback', {
    ticketId: 'BUG-481', content: 'x', transition: { action: '開始開發' }, idempotencyKey: KEY
  }, cfg(), fetchImpl);

  assert.strictEqual(fetchImpl.calls.length, 2, '不自動重試');
  const text = result.content[0].text;
  assert.strictEqual(result.structuredContent.partial.failedStepApplied, 'unknown');
  assert.match(text, /24 小時/, '必須點出保留期是有限的');
  assert.match(text, /先讀|讀工單當前狀態/, '重送前要先確認當前狀態');
  assert.ok(!/一定不會做第二次|永遠(可|安全)/.test(text), '不得承諾無限期 exactly-once');
});

test('一般 4xx 的「沒有生效」指示要求保留已完成步驟，不叫人換新 key 重跑整串', async function () {
  const fetchImpl = seqFetch([
    { status: 200, body: { data: {} } },
    { status: 403, body: { error: { code: 'permission_denied', message: '沒有留言權限' } } }
  ]);
  const result = await callTool('litejira.replyFeedback', {
    ticketId: 'BUG-481', content: 'x', transition: { action: '開始開發' }, idempotencyKey: KEY
  }, cfg(), fetchImpl);

  const text = result.content[0].text;
  assert.strictEqual(result.structuredContent.partial.failedStepApplied, 'no');
  assert.strictEqual(result.structuredContent.partial.idempotencyReuse, undefined,
    '不是 key 重用的錯誤就不要硬加這個欄位');
  assert.match(text, /只補真正還沒做的那一步|保留.*已完成/);
  assert.match(text, /不要換新 key/);
});

test('idempotencyKey 的說明與 instructions 不承諾無限期去重', async function () {
  const tools = listTools();
  const desc = tools.find(function (t) { return t.name === 'litejira.replyFeedback'; })
    .inputSchema.properties.idempotencyKey.description;
  assert.match(desc, /24 小時|保留期/);
  assert.ok(!/永遠/.test(desc), '不得宣稱永遠安全');

  const res = await rpc('initialize', { protocolVersion: '2025-06-18' }, cfg(), neverFetch());
  const instructions = res.result.instructions;
  assert.match(instructions, /24 小時|保留期/);
});

test('replyFeedback：沒有 transition 時不接受 expectedUpdatedAt（留言端點沒有樂觀鎖）', async function () {
  const never = neverFetch();
  await assert.rejects(
    callTool('litejira.replyFeedback',
      { ticketId: 'BUG-481', content: 'x', expectedUpdatedAt: ISO, idempotencyKey: KEY }, cfg(), never),
    function (err) {
      assert.strictEqual(err.code, 'VALIDATION_FAILED');
      assert.match(err.message, /expectedUpdatedAt/);
      return true;
    }
  );
  assert.strictEqual(never.calls.length, 0);
});

test('replyFeedback：transition 只收動作標籤，toStatus 明確指路', async function () {
  const never = neverFetch();
  for (const bad of [{ toStatus: '開發中' }, { status: '開發中' }, { action: '' }]) {
    await assert.rejects(
      callTool('litejira.replyFeedback',
        { ticketId: 'BUG-481', content: 'x', transition: bad, idempotencyKey: KEY }, cfg(), never),
      function (err) { return err.code === 'VALIDATION_FAILED'; },
      JSON.stringify(bad)
    );
  }
  const response = await rpc('tools/call', {
    name: 'litejira.replyFeedback',
    arguments: { ticketId: 'BUG-481', content: 'x', transition: { toStatus: '開發中' }, idempotencyKey: KEY }
  }, cfg(), never);
  assert.match(response.error.message, /action/);
  assert.strictEqual(never.calls.length, 0);
});

// ── 批次：一發打 batch 端點，回部分成功 ──

test('batchTransition 送 POST /tickets/batch/transitions，一發處理整批', async function () {
  const data = {
    succeeded: [{ ticket: 'BUG-481', id: UUID, key: 'BUG-481', status: '開發中', assignee: { id: UUID2, name: '思源' } }],
    failed: [{ ticket: 'BUG-482', error: { code: 'state_conflict', message: '狀態不符' } }]
  };
  const fetchImpl = okFetch(data);
  const result = await callTool('litejira.batchTransition', {
    tickets: ['BUG-481', 'BUG-482'], action: '開始開發', reason: '接手',
    fields: { fixMethod: '改設定' }, idempotencyKey: KEY
  }, cfg(), fetchImpl);

  assert.strictEqual(fetchImpl.calls.length, 1, '批次是一發呼叫，不是逐張迴圈');
  assert.strictEqual(fetchImpl.calls[0].init.method, 'POST');
  assert.strictEqual(fetchImpl.calls[0].url, V1 + '/tickets/batch/transitions');
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].init.body), {
    tickets: ['BUG-481', 'BUG-482'], action: '開始開發', reason: '接手', fields: { fixMethod: '改設定' }
  });
  // 結果原樣轉出：succeeded / failed 不得被改名成舊的 success
  assert.deepStrictEqual(result.structuredContent, data);
  assert.strictEqual(result.structuredContent.success, undefined);
  assert.strictEqual(result.isError, undefined, '部分失敗仍是 HTTP 200 的正常回應');
});

test('batchReassign 送 POST /tickets/batch/assignee，assigneeId 收 UUID、reason 必填', async function () {
  const fetchImpl = okFetch({ succeeded: [], failed: [] });
  await callTool('litejira.batchReassign', {
    tickets: ['BUG-481', UUID3, '4821'], assigneeId: UUID2, reason: '交接', idempotencyKey: KEY
  }, cfg(), fetchImpl);
  assert.strictEqual(fetchImpl.calls[0].url, V1 + '/tickets/batch/assignee');
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].init.body), {
    tickets: ['BUG-481', UUID3, '4821'], assigneeId: UUID2, reason: '交接'
  });

  const never = neverFetch();
  const response = await rpc('tools/call', {
    name: 'litejira.batchReassign',
    arguments: { tickets: ['BUG-481'], newAssignee: '思源', reason: 'x', idempotencyKey: KEY }
  }, cfg(), never);
  assert.strictEqual(response.error.data.code, 'VALIDATION_FAILED');
  assert.match(response.error.message, /assigneeId/);
  assert.strictEqual(never.calls.length, 0);
});

test('batchSetField 一般欄位包成 fields 物件送 POST /tickets/batch/fields', async function () {
  const fetchImpl = okFetch({ succeeded: [], failed: [] });
  await callTool('litejira.batchSetField', {
    tickets: ['BUG-481', 'BUG-482'], field: 'priority', value: 'P0-緊急', idempotencyKey: KEY
  }, cfg(), fetchImpl);
  assert.strictEqual(fetchImpl.calls[0].url, V1 + '/tickets/batch/fields');
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].init.body), {
    tickets: ['BUG-481', 'BUG-482'], fields: { priority: 'P0-緊急' }
  });
});

test('batchSetField field=parentId 收工單參照（與單張只收 UUID 不同），也可傳 null', async function () {
  const byKey = okFetch({ succeeded: [], failed: [] });
  await callTool('litejira.batchSetField',
    { tickets: ['BUG-481'], field: 'parentId', value: 'EPIC-12', idempotencyKey: KEY }, cfg(), byKey);
  assert.deepStrictEqual(JSON.parse(byKey.calls[0].init.body),
    { tickets: ['BUG-481'], fields: { parentId: 'EPIC-12' } });

  const unlink = okFetch({ succeeded: [], failed: [] });
  await callTool('litejira.batchSetField',
    { tickets: ['BUG-481'], field: 'parentId', value: null, idempotencyKey: KEY }, cfg(), unlink);
  assert.deepStrictEqual(JSON.parse(unlink.calls[0].init.body),
    { tickets: ['BUG-481'], fields: { parentId: null } });
});

test('batchSetField 版本欄位改走 POST /tickets/batch/versions（收版本 UUID，可帶 reason）', async function () {
  const fetchImpl = okFetch({ succeeded: [], failed: [] });
  await callTool('litejira.batchSetField', {
    tickets: ['BUG-481'], field: 'targetVersion', value: UUID3, reason: '統一延期', idempotencyKey: KEY
  }, cfg(), fetchImpl);
  assert.strictEqual(fetchImpl.calls[0].url, V1 + '/tickets/batch/versions');
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].init.body),
    { tickets: ['BUG-481'], targetVersionId: UUID3, reason: '統一延期' });

  const found = okFetch({ succeeded: [], failed: [] });
  await callTool('litejira.batchSetField',
    { tickets: ['BUG-481'], field: 'foundVersion', value: null, idempotencyKey: KEY }, cfg(), found);
  assert.deepStrictEqual(JSON.parse(found.calls[0].init.body),
    { tickets: ['BUG-481'], foundVersionId: null });
});

test('batchSetField：一般欄位的批次端點不收 reason，status 也不是批次欄位', async function () {
  const never = neverFetch();
  await assert.rejects(
    callTool('litejira.batchSetField',
      { tickets: ['BUG-481'], field: 'module', value: '帳號', reason: '順手', idempotencyKey: KEY }, cfg(), never),
    function (err) {
      assert.strictEqual(err.code, 'VALIDATION_FAILED');
      assert.match(err.message, /reason/);
      return true;
    }
  );
  const response = await rpc('tools/call', {
    name: 'litejira.batchSetField',
    arguments: { tickets: ['BUG-481'], field: 'status', value: '開發中', idempotencyKey: KEY }
  }, cfg(), never);
  assert.strictEqual(response.error.data.code, 'VALIDATION_FAILED');
  assert.match(response.error.message, /batchTransition/);
  assert.strictEqual(never.calls.length, 0);
});

test('批次工具：ids / expectedUpdatedAt 這些舊參數明確指路，不靜默忽略', async function () {
  const never = neverFetch();
  const cases = [
    ['litejira.batchTransition', { ids: ['BUG-481'], action: 'x', idempotencyKey: KEY }, /tickets/],
    ['litejira.batchTransition',
      { tickets: ['BUG-481'], action: 'x', expectedUpdatedAt: ISO, idempotencyKey: KEY }, /樂觀鎖/],
    ['litejira.batchTransition',
      { tickets: ['BUG-481'], action: 'x', extraFields: {}, idempotencyKey: KEY }, /fields/],
    ['litejira.batchSetField',
      { ids: ['BUG-481'], field: 'priority', value: 'P1-高', idempotencyKey: KEY }, /tickets/]
  ];
  for (const triple of cases) {
    const response = await rpc('tools/call', { name: triple[0], arguments: triple[1] }, cfg(), never);
    assert.strictEqual(response.error.data.code, 'VALIDATION_FAILED', triple[0]);
    assert.match(response.error.message, triple[2], triple[0]);
  }
  assert.strictEqual(never.calls.length, 0);
});

test('批次工具：超過 100 張或空清單在本機就擋下', async function () {
  const never = neverFetch();
  const tooMany = [];
  for (let i = 0; i < 101; i++) tooMany.push('BUG-' + (i + 1));
  for (const tickets of [tooMany, []]) {
    const response = await rpc('tools/call', {
      name: 'litejira.batchTransition',
      arguments: { tickets: tickets, action: '開始開發', idempotencyKey: KEY }
    }, cfg(), never);
    assert.ok(response.error, '長度 ' + tickets.length + ' 應該被擋');
  }
  assert.strictEqual(never.calls.length, 0);
});

test('批次工具：整批被伺服器拒絕時原樣回報，不退化成逐張單張寫入', async function () {
  const fetchImpl = errFetch(403, { code: 'permission_denied', message: '沒有批次操作權限' });
  const result = await callTool('litejira.batchTransition',
    { tickets: ['BUG-481', 'BUG-482', 'BUG-483'], action: '開始開發', idempotencyKey: KEY }, cfg(), fetchImpl);
  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.structuredContent.error.code, 'permission_denied');
  assert.strictEqual(fetchImpl.calls.length, 1, '被拒絕不得改用 N 次單張寫入繞過');
});

// ── 傳輸層：MCP 走不到、但契約上必須守住的邊界 ──

test('傳輸層：批次 tickets 只收工單參照三形狀，且上限 100', function () {
  assert.throws(function () {
    buildRequest({
      baseUrl: BASE, token: TOKEN, action: 'batchReassign', idempotencyKey: KEY,
      params: { tickets: ['思源'], assigneeId: UUID2, reason: 'x' }
    });
  }, function (err) {
    return err instanceof LiteJiraTransportError && err.code === 'invalid_argument';
  });
});

test('傳輸層：批次 fields 的 parentId 必須單獨成批', function () {
  assert.throws(function () {
    buildRequest({
      baseUrl: BASE, token: TOKEN, action: 'batchSetField', idempotencyKey: KEY,
      params: { tickets: ['BUG-481'], fields: { parentId: 'EPIC-12', priority: 'P1-高' } }
    });
  }, function (err) {
    return err instanceof LiteJiraTransportError && /單獨成批/.test(err.message);
  });
});

test('傳輸層：版本端點至少要帶一個版本欄位（全省略等於什麼都沒改）', function () {
  assert.throws(function () {
    buildRequest({
      baseUrl: BASE, token: TOKEN, action: 'setTicketVersions', idempotencyKey: KEY,
      params: { ticketId: 'BUG-481', reason: 'x' }
    });
  }, function (err) {
    return err instanceof LiteJiraTransportError && err.code === 'invalid_argument';
  });
});

test('傳輸層：updateField / replyFeedback 是複合 action，明講該拆成哪幾條路由', function () {
  const { PENDING_CONTRACT_ACTIONS } = require('../litejira-v1-transport');
  assert.deepStrictEqual(PENDING_CONTRACT_ACTIONS.slice(), [], '第四包後不該還有「契約未取得」的 action');

  assert.throws(function () {
    buildRequest({ baseUrl: BASE, token: TOKEN, action: 'updateField', idempotencyKey: KEY, params: {} });
  }, function (err) {
    return err instanceof LiteJiraTransportError && err.code === 'composite_action' &&
      /updateTicketField/.test(err.message);
  });
  assert.throws(function () {
    buildRequest({ baseUrl: BASE, token: TOKEN, action: 'replyFeedback', idempotencyKey: KEY, params: {} });
  }, function (err) {
    return err instanceof LiteJiraTransportError && err.code === 'composite_action' &&
      /addComment/.test(err.message);
  });
});

test('傳輸層：PATCH 一般欄位端點不收 reason / status / 舊欄位名，一律指路', function () {
  [['reason', /reason/], ['status', /transitionTicket/], ['verifyMethod', /validationMethod/],
    ['notes', /description/], ['version', /targetVersionId/]].forEach(function (pair) {
    const params = { ticket: 'BUG-481' };
    params[pair[0]] = 'x';
    assert.throws(function () {
      buildRequest({ baseUrl: BASE, token: TOKEN, action: 'updateTicketField', idempotencyKey: KEY, params: params });
    }, function (err) {
      return err instanceof LiteJiraTransportError && pair[1].test(err.message);
    }, pair[0]);
  });
});

// ── 啟動指令 / prompt：不得再說「未接線」──

test('initialize 的 instructions 不再宣稱有工具未接線，且講明批次的部分成功', async function () {
  const response = await rpc('initialize', {}, cfg(), neverFetch());
  const text = response.result.instructions;
  // GH-317：預算維持 1000（附件那一行擠進既有額度，細節在工具 schema）。
  assert.ok(text.length <= 1000, 'instructions 長度 ' + text.length + ' 超出預算');
  assert.ok(!/未接線|尚未接/.test(text), 'instructions 不得再說有工具未接線');
  assert.match(text, /failed/);
  assert.match(text, /replyFeedback/);
  assert.match(text, /updateField/);
});

test('prompt 收尾語只提得到 tools/list 裡真的有的工具', async function () {
  const available = listTools().map(function (t) { return t.name; });
  const cases = [
    ['report-bug', { title: 'T' }],
    ['weekly-status', {}],
    ['triage-ticket', { ticketId: 'BUG-481' }],
    ['close-ticket', { ticketId: 'BUG-481' }]
  ];
  for (const pair of cases) {
    const response = await rpc('prompts/get', { name: pair[0], arguments: pair[1] }, cfg(), neverFetch());
    const text = response.result.messages[0].content.text;
    const mentioned = text.match(/litejira\.[A-Za-z]+/g) || [];
    mentioned.forEach(function (name) {
      assert.ok(available.indexOf(name) !== -1, pair[0] + ' 提到不存在的工具 ' + name);
    });
    assert.ok(!/尚未接上|未接線/.test(text), pair[0] + ' 不得再宣稱有工具未接線');
  }
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

// 多發呼叫、每發不同回應（複合操作要驗的就是「第 N 發送了什麼、收到什麼」）。
function seqFetch(responses) {
  const calls = [];
  const fetchImpl = function (url, init) {
    const spec = responses[calls.length];
    calls.push({ url: url, init: init });
    if (!spec) throw new Error('超出預期的第 ' + calls.length + ' 發請求：' + url);
    return Promise.resolve({
      status: spec.status,
      text: function () { return Promise.resolve(JSON.stringify(spec.body)); }
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
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
