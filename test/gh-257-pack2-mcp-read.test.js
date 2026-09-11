'use strict';

// GH-257 第二包：MCP 讀取面（4 tools + 6 resources + 4 prompts）改走 API v1。
// 全部測試都注入假 fetch，走真正的 JSON-RPC handler（不是只驗 list），不接觸真 API、不讀憑證。

const test = require('node:test');
const assert = require('node:assert');

const {
  callTool,
  handleJsonRpcRequest,
  listTools
} = require('../litejira-mcp-server');

const BASE = 'https://litejira.example.com';
const V1 = BASE + '/api/v1';
const TOKEN = 'ltj_pat_test_abcdefgh';
const UUID = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';
const UUID2 = '8a7b6c5d-4e3f-4a2b-9c8d-7e6f5a4b3c2d';

test('resources 不讓 query 覆蓋路徑或先前同名參數', async () => {
  for (const uri of [
    'litejira://workflow/BUG?type=REQ',
    'litejira://meta?project=LTJ&project=OTHER',
    'litejira://members?activeOnly=true&activeOnly=false'
  ]) {
    const response = await rpc('resources/read', { uri }, cfg(), neverFetch());
    assert.equal(response.error.data.code, 'INVALID_RESOURCE_URI');
  }
});

function cfg(extra) {
  return Object.assign({
    apiUrl: BASE,
    token: TOKEN,
    project: 'LTJ',
    enableWrites: true   // 刻意打開：證明未升級的寫入工具不是靠這個開關擋住的
  }, extra || {});
}

// 假 fetch：記錄每一發請求，回 v1 的 { data } 信封。
function recorder(payload, status) {
  const calls = [];
  const fetchImpl = function (url, init) {
    calls.push({ url: url, init: init });
    return Promise.resolve({
      status: status || 200,
      text: function () { return Promise.resolve(JSON.stringify(payload)); }
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function okFetch(data) {
  return recorder({ data: data });
}

function errFetch(status, error) {
  return recorder({ error: error }, status);
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

// v1 契約的新 shape：UUID 主鍵 + 公開 key + member { id, name } + nextCursor。
const TICKET_ITEM = {
  id: UUID,
  key: 'BUG-481',
  title: '登入逾時',
  status: '開發中',
  assignee: { id: UUID2, name: '思源' },
  owner: null,
  updatedAt: '2026-09-10T08:30:00.123456Z'
};

// ── 讀取工具：真 method / path / query ──

test('searchTickets 走 GET /api/v1/tickets，帶 Bearer，且不再用舊的 POST body token', async function () {
  const fetchImpl = okFetch({ items: [TICKET_ITEM], nextCursor: 'Y3Vyc29y' });
  await callTool('litejira.searchTickets', { q: '登入', limit: 20 }, cfg(), fetchImpl);

  assert.strictEqual(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.strictEqual(call.init.method, 'GET');
  assert.strictEqual(call.init.body, undefined, '讀取不得帶 body');
  assert.strictEqual(call.init.headers.Authorization, 'Bearer ' + TOKEN);
  // 舊契約是「單一 POST 端點 + body 裡夾 token」，v1 路徑上必須完全消失。
  assert.ok(call.url.indexOf('/api/v1/tickets') !== -1, '實際 URL：' + call.url);
  assert.strictEqual(call.init.redirect, 'manual');
});

test('searchTickets 沒帶 project 時採用 LTJ_PROJECT；URI 上明給則以明給為準', async function () {
  const a = okFetch({ items: [] });
  await callTool('litejira.searchTickets', { q: 'x' }, cfg(), a);
  assert.ok(a.calls[0].url.indexOf('project=LTJ') !== -1, a.calls[0].url);

  const b = okFetch({ items: [] });
  await callTool('litejira.searchTickets', { q: 'x', project: 'OTHER' }, cfg(), b);
  assert.ok(b.calls[0].url.indexOf('project=OTHER') !== -1, b.calls[0].url);
  assert.ok(b.calls[0].url.indexOf('project=LTJ') === -1);

  // 沒有 LTJ_PROJECT 也沒有明給 → 不猜，就是不帶這個條件（跨專案搜尋）。
  const c = okFetch({ items: [] });
  await callTool('litejira.searchTickets', { q: 'x' }, cfg({ project: '' }), c);
  assert.ok(c.calls[0].url.indexOf('project=') === -1, c.calls[0].url);
});

test('searchTickets 多值條件送重複 query，不做逗號串接', async function () {
  const fetchImpl = okFetch({ items: [] });
  await callTool('litejira.searchTickets', {
    status: ['開發中', '待測試'],
    type: 'BUG',
    targetVersion: ['1.2.0']
  }, cfg({ project: '' }), fetchImpl);

  const query = decodeURIComponent(fetchImpl.calls[0].url.split('?')[1]);
  assert.ok(query.indexOf('status=開發中&status=待測試') !== -1, query);
  assert.ok(query.indexOf('type=BUG') !== -1, query);
  assert.ok(query.indexOf(',') === -1, '不得出現逗號串接：' + query);
});

test('searchTickets 成員條件只收 UUID，顯示名參數被明確拒絕並指路', async function () {
  const fetchImpl = neverFetch();

  // UUID 放行
  const ok = okFetch({ items: [] });
  await callTool('litejira.searchTickets', { assigneeId: UUID2 }, cfg({ project: '' }), ok);
  assert.ok(ok.calls[0].url.indexOf('assigneeId=' + UUID2) !== -1);

  // 顯示名 → 拒絕，且訊息要指出改用哪個參數
  const cases = [
    ['assignee', /assigneeId/],
    ['owner', /ownerId/],
    ['creator', /creatorId/],
    ['version', /targetVersion/]
  ];
  for (const pair of cases) {
    await assert.rejects(
      () => callTool('litejira.searchTickets', { [pair[0]]: '思源' }, cfg(), fetchImpl),
      (err) => {
        assert.strictEqual(err.code, 'VALIDATION_FAILED');
        assert.match(err.message, pair[1]);
        return true;
      },
      pair[0] + ' 應被拒絕'
    );
  }

  // 非 UUID 的 assigneeId 也不放行（不從字串猜人）
  await assert.rejects(
    () => callTool('litejira.searchTickets', { assigneeId: '思源' }, cfg(), fetchImpl),
    (err) => err.code === 'VALIDATION_FAILED'
  );
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test('searchTickets 的 sort 值域換成 v1 契約（updatedAt/createdAt/key），舊的 priority 不再接受', async function () {
  const def = listTools().find((t) => t.name === 'litejira.searchTickets');
  assert.deepStrictEqual(def.inputSchema.properties.sort.enum, ['updatedAt', 'createdAt', 'key']);

  const fetchImpl = okFetch({ items: [] });
  await callTool('litejira.searchTickets', { sort: 'key', order: 'asc' }, cfg({ project: '' }), fetchImpl);
  assert.ok(fetchImpl.calls[0].url.indexOf('sort=key&order=asc') !== -1, fetchImpl.calls[0].url);

  await assert.rejects(
    () => callTool('litejira.searchTickets', { sort: 'priority' }, cfg(), neverFetch()),
    (err) => err.code === 'VALIDATION_FAILED'
  );
});

test('listComments 走 GET /tickets/{ref}/comments，limit/cursor/order 帶進 query', async function () {
  const fetchImpl = okFetch({ items: [{ id: UUID, author: { id: UUID2, name: '思源' }, body: 'ok' }], nextCursor: null });
  await callTool('litejira.listComments',
    { ticketId: 'BUG-481', limit: 10, cursor: 'abc', order: 'asc' }, cfg(), fetchImpl);

  assert.strictEqual(fetchImpl.calls[0].url,
    V1 + '/tickets/BUG-481/comments?limit=10&cursor=abc&order=asc');
  assert.strictEqual(fetchImpl.calls[0].init.method, 'GET');
});

test('工單參照三種形狀都收：UUID / 公開 key / 純數字 key', async function () {
  for (const ref of [UUID, 'BUG-481', '481']) {
    const fetchImpl = okFetch({ items: [] });
    await callTool('litejira.listComments', { ticketId: ref }, cfg(), fetchImpl);
    assert.strictEqual(fetchImpl.calls[0].url, V1 + '/tickets/' + ref + '/comments');
  }
  // 不是這三種形狀就本機擋下，不送出去碰運氣
  await assert.rejects(
    () => callTool('litejira.listComments', { ticketId: '隨便打的字' }, cfg(), neverFetch()),
    (err) => err.code === 'VALIDATION_FAILED'
  );
});

test('getActivityLog 用 kind 單選；舊的兩個布林參數被拒絕並指路 kind', async function () {
  const fetchImpl = okFetch({ items: [], nextCursor: null });
  await callTool('litejira.getActivityLog', { ticketId: '481', kind: 'system', limit: 5 }, cfg(), fetchImpl);
  assert.strictEqual(fetchImpl.calls[0].url, V1 + '/tickets/481/activity?kind=system&limit=5');

  // 不帶 kind = 全部（不自作主張補預設）
  const all = okFetch({ items: [] });
  await callTool('litejira.getActivityLog', { ticketId: '481' }, cfg(), all);
  assert.strictEqual(all.calls[0].url, V1 + '/tickets/481/activity');

  for (const legacy of ['includeComments', 'includeSystemEvents']) {
    await assert.rejects(
      () => callTool('litejira.getActivityLog', { ticketId: '481', [legacy]: true }, cfg(), neverFetch()),
      (err) => {
        assert.strictEqual(err.code, 'VALIDATION_FAILED');
        assert.match(err.message, /kind=user\|system/);
        return true;
      },
      legacy + ' 應被拒絕而不是靜默忽略'
    );
  }

  await assert.rejects(
    () => callTool('litejira.getActivityLog', { ticketId: '481', kind: 'both' }, cfg(), neverFetch()),
    (err) => err.code === 'VALIDATION_FAILED'
  );
});

test('getTransitions 走 GET /tickets/{ticketId}/transitions，完全不帶 query', async function () {
  const payload = {
    group: 'BUG',
    status: '待開發',
    transitions: ['開發中', '已取消', '廢單', '退單'],
    actions: [{ label: '開始開發', toStatus: '開發中', direction: 'forward' }],
    isFinal: false
  };
  const fetchImpl = okFetch(payload);
  const result = await callTool('litejira.getTransitions', { ticketId: 'BUG-481' }, cfg(), fetchImpl);

  assert.strictEqual(fetchImpl.calls[0].url, V1 + '/tickets/BUG-481/transitions');
  assert.strictEqual(fetchImpl.calls[0].url.indexOf('?'), -1, '此端點沒有任何 query 參數');
  // { data } 只拆一層，內容原樣保留（actions / transitions 都在）
  assert.deepStrictEqual(result.structuredContent, payload);
});

test('{ data } 信封只拆一層，新 shape（UUID id / 公開 key / member 物件 / nextCursor）原樣保留', async function () {
  const data = { items: [TICKET_ITEM], nextCursor: 'Y3Vyc29y' };
  const fetchImpl = okFetch(data);
  const result = await callTool('litejira.searchTickets', {}, cfg(), fetchImpl);

  assert.deepStrictEqual(result.structuredContent, data);
  assert.deepStrictEqual(JSON.parse(result.content[0].text), data);
  // 逐項確認沒有被「壓扁」成舊 shape
  const item = result.structuredContent.items[0];
  assert.strictEqual(item.id, UUID);
  assert.strictEqual(item.key, 'BUG-481');
  assert.deepStrictEqual(item.assignee, { id: UUID2, name: '思源' });
  assert.strictEqual(item.owner, null, '未指派是 null，不能變成空字串或 {}');
  assert.strictEqual(result.structuredContent.nextCursor, 'Y3Vyc29y');
});

// ── 錯誤語意 ──

test('後端錯誤的 code / message / details 原樣帶出，不重映射回舊的四種代碼', async function () {
  const error = { code: 'membership_required', message: '你不是這個專案的成員', details: { project: 'LTJ' } };
  const fetchImpl = errFetch(403, error);
  const result = await callTool('litejira.searchTickets', {}, cfg(), fetchImpl);

  assert.strictEqual(result.isError, true);
  assert.deepStrictEqual(result.structuredContent.error.code, 'membership_required');
  assert.deepStrictEqual(result.structuredContent.error.message, '你不是這個專案的成員');
  assert.deepStrictEqual(result.structuredContent.error.details, { project: 'LTJ' });
  assert.strictEqual(result.structuredContent.error.status, 403);
  assert.match(result.content[0].text, /\[membership_required\]/);

  // 舊的四碼不得在 v1 路徑上出現
  ['AUTH_FAILED', 'UNKNOWN_ACTION', 'ADMIN_REQUIRED', 'ACTION_FAILED'].forEach(function (legacy) {
    assert.ok(result.content[0].text.indexOf(legacy) === -1, '不應重映射成 ' + legacy);
  });
});

test('403 底下三種互斥語意各自保留，不被狀態碼壓成同一種', async function () {
  const seen = [];
  for (const code of ['membership_required', 'permission_denied', 'admin_required']) {
    const result = await callTool('litejira.searchTickets', {}, cfg(),
      errFetch(403, { code: code, message: 'x' }));
    seen.push(result.structuredContent.error.code);
  }
  assert.deepStrictEqual(seen, ['membership_required', 'permission_denied', 'admin_required']);
});

// ── 未升級的寫入工具：保持禁用，且不得退回舊後端 ──

test('本包只公告 4 個已接線的讀取工具，14 個寫入工具不出現在 tools/list', async function () {
  const names = listTools().map((t) => t.name);
  assert.deepStrictEqual(names.sort(), [
    'litejira.getActivityLog',
    'litejira.getTransitions',
    'litejira.listComments',
    'litejira.searchTickets'
  ]);
});

test('未升級的 14 個寫入工具一律本機拒絕，一發請求都不送（即使 enableWrites=true）', async function () {
  const pending = [
    'litejira.linkTickets', 'litejira.replyFeedback', 'litejira.attachLink',
    'litejira.removeAttachment', 'litejira.updateField', 'litejira.createTicket',
    'litejira.addComment', 'litejira.reassignTicket', 'litejira.convertTicketType',
    'litejira.toggleWatch', 'litejira.transitionTicket', 'litejira.batchTransition',
    'litejira.batchReassign', 'litejira.batchSetField'
  ];
  assert.strictEqual(pending.length, 14);

  const fetchImpl = neverFetch();
  for (const name of pending) {
    const response = await rpc('tools/call', { name: name, arguments: {} }, cfg(), fetchImpl);
    assert.ok(response.error, name + ' 應該失敗');
    assert.strictEqual(response.error.data.code, 'TOOL_NOT_MIGRATED', name);
    assert.match(response.error.message, /尚未接上 API v1/);
  }
  assert.strictEqual(fetchImpl.calls.length, 0, '未升級的工具不得打出任何請求');
});

// ── Resources：6 個逐項真呼叫 ──

test('resources/list 回 4 個固定 URI，resources/templates/list 回 2 個模板', async function () {
  const fixed = await rpc('resources/list', {}, cfg(), neverFetch());
  assert.deepStrictEqual(fixed.result.resources.map((r) => r.uri), [
    'litejira://meta', 'litejira://members', 'litejira://versions', 'litejira://dashboard'
  ]);

  const templates = await rpc('resources/templates/list', {}, cfg(), neverFetch());
  assert.deepStrictEqual(templates.result.resourceTemplates.map((r) => r.uriTemplate), [
    'litejira://workflow/{type}', 'litejira://ticket/{id}'
  ]);
});

test('六個 resource 逐一真讀，各自打到正確的 v1 端點', async function () {
  const cases = [
    ['litejira://meta', V1 + '/meta?project=LTJ'],
    ['litejira://members', V1 + '/members'],
    ['litejira://versions', V1 + '/versions?project=LTJ'],
    ['litejira://dashboard', V1 + '/stats?project=LTJ'],
    ['litejira://workflow/BUG', V1 + '/workflow?type=BUG&project=LTJ'],
    ['litejira://ticket/BUG-481', V1 + '/tickets/BUG-481']
  ];

  for (const pair of cases) {
    const payload = { probe: pair[0] };
    const fetchImpl = okFetch(payload);
    const response = await rpc('resources/read', { uri: pair[0] }, cfg(), fetchImpl);

    assert.ok(!response.error, pair[0] + ' 讀取失敗：' + JSON.stringify(response.error));
    assert.strictEqual(fetchImpl.calls.length, 1, pair[0]);
    assert.strictEqual(fetchImpl.calls[0].url, pair[1], pair[0]);
    assert.strictEqual(fetchImpl.calls[0].init.method, 'GET');
    assert.strictEqual(fetchImpl.calls[0].init.headers.Authorization, 'Bearer ' + TOKEN);
    // 內容原樣輸出（只拆一層信封）
    assert.strictEqual(response.result.contents[0].uri, pair[0]);
    assert.deepStrictEqual(JSON.parse(response.result.contents[0].text), payload);
  }
});

test('members 是工作區名冊：即使有 LTJ_PROJECT 也絕不帶 project', async function () {
  const fetchImpl = okFetch([{ id: UUID2, name: '思源' }]);
  await rpc('resources/read', { uri: 'litejira://members' }, cfg(), fetchImpl);
  assert.strictEqual(fetchImpl.calls[0].url, V1 + '/members');
  assert.strictEqual(fetchImpl.calls[0].url.indexOf('project'), -1);

  // 明著塞 project 也要被擋，而不是靜默丟掉
  const response = await rpc('resources/read', { uri: 'litejira://members?project=LTJ' }, cfg(), neverFetch());
  assert.ok(response.error);
  assert.strictEqual(response.error.data.code, 'INVALID_RESOURCE_URI');
});

test('members 支援 activeOnly / jobRole，activeOnly 只收 true|false 字面值', async function () {
  const fetchImpl = okFetch([]);
  await rpc('resources/read', { uri: 'litejira://members?activeOnly=false&jobRole=QA' }, cfg(), fetchImpl);
  assert.strictEqual(fetchImpl.calls[0].url, V1 + '/members?activeOnly=false&jobRole=QA');

  const bad = await rpc('resources/read', { uri: 'litejira://members?activeOnly=1' }, cfg(), neverFetch());
  assert.strictEqual(bad.error.data.code, 'INVALID_RESOURCE_URI');
});

test('URI 的 ?project= 覆寫 LTJ_PROJECT', async function () {
  const fetchImpl = okFetch({});
  await rpc('resources/read', { uri: 'litejira://meta?project=OTHER' }, cfg(), fetchImpl);
  assert.strictEqual(fetchImpl.calls[0].url, V1 + '/meta?project=OTHER');
});

test('缺 project 時清楚報錯，不自動猜第一個專案', async function () {
  const noProject = cfg({ project: '' });
  const fetchImpl = neverFetch();

  for (const uri of ['litejira://meta', 'litejira://versions', 'litejira://dashboard', 'litejira://workflow/BUG']) {
    const response = await rpc('resources/read', { uri: uri }, noProject, fetchImpl);
    assert.ok(response.error, uri + ' 應該報錯');
    assert.strictEqual(response.error.data.code, 'PROJECT_REQUIRED', uri);
    assert.match(response.error.message, /\?project=/);
    assert.match(response.error.message, /LTJ_PROJECT/);
  }
  assert.strictEqual(fetchImpl.calls.length, 0, '缺 project 不得送出半套查詢');

  // 不需要 project 的兩個資源在同樣設定下仍然可用
  const members = okFetch([]);
  const ok = await rpc('resources/read', { uri: 'litejira://members' }, noProject, members);
  assert.ok(!ok.error);
});

test('dashboard 的 scope / targetVersion / role 三者互斥', async function () {
  const scoped = okFetch({});
  await rpc('resources/read', { uri: 'litejira://dashboard?scope=me' }, cfg(), scoped);
  assert.strictEqual(scoped.calls[0].url, V1 + '/stats?scope=me&project=LTJ');

  const versioned = okFetch({});
  await rpc('resources/read', { uri: 'litejira://dashboard?targetVersion=1.2.0' }, cfg(), versioned);
  assert.strictEqual(versioned.calls[0].url, V1 + '/stats?targetVersion=1.2.0&project=LTJ');

  const clash = await rpc('resources/read',
    { uri: 'litejira://dashboard?scope=me&targetVersion=1.2.0' }, cfg(), neverFetch());
  assert.ok(clash.error);
  assert.strictEqual(clash.error.data.code, 'invalid_argument');
  assert.match(clash.error.message, /互斥/);

  const badScope = await rpc('resources/read', { uri: 'litejira://dashboard?scope=team' }, cfg(), neverFetch());
  assert.strictEqual(badScope.error.data.code, 'invalid_argument');
});

test('workflow 的 type 可省略，flowGroupCode 可選；未列的 query 一律拒絕', async function () {
  const all = okFetch({});
  await rpc('resources/read', { uri: 'litejira://workflow/' }, cfg(), all);
  assert.strictEqual(all.calls[0].url, V1 + '/workflow?project=LTJ');

  const grouped = okFetch({});
  await rpc('resources/read', { uri: 'litejira://workflow/BUG?flowGroupCode=DEV' }, cfg(), grouped);
  assert.strictEqual(grouped.calls[0].url, V1 + '/workflow?type=BUG&flowGroupCode=DEV&project=LTJ');

  const bad = await rpc('resources/read', { uri: 'litejira://workflow/BUG?limit=5' }, cfg(), neverFetch());
  assert.strictEqual(bad.error.data.code, 'INVALID_RESOURCE_URI');
  assert.match(bad.error.message, /limit/);
});

test('ticket 資源接受三種工單參照，未知 URI 仍報 UNKNOWN_RESOURCE', async function () {
  for (const ref of [UUID, 'BUG-481', '481']) {
    const fetchImpl = okFetch({ id: UUID, key: 'BUG-481' });
    await rpc('resources/read', { uri: 'litejira://ticket/' + ref }, cfg(), fetchImpl);
    assert.strictEqual(fetchImpl.calls[0].url, V1 + '/tickets/' + ref);
  }

  const unknown = await rpc('resources/read', { uri: 'litejira://nope' }, cfg(), neverFetch());
  assert.strictEqual(unknown.error.data.code, 'UNKNOWN_RESOURCE');
});

test('resource 的後端錯誤走 JSON-RPC error，code 維持後端原文', async function () {
  const response = await rpc('resources/read', { uri: 'litejira://meta' }, cfg(),
    errFetch(404, { code: 'not_found', message: '專案不存在', details: { project: 'LTJ' } }));
  assert.strictEqual(response.error.data.code, 'not_found');
  assert.strictEqual(response.error.message, '專案不存在');
  assert.deepStrictEqual(response.error.data.details, { project: 'LTJ' });
});

// ── Prompts：4 個逐項真呼叫 ──

test('prompts/list 回 4 個 prompt', async function () {
  const response = await rpc('prompts/list', {}, cfg(), neverFetch());
  assert.deepStrictEqual(response.result.prompts.map((p) => p.name),
    ['report-bug', 'weekly-status', 'triage-ticket', 'close-ticket']);
});

test('四個 prompt 逐一 prompts/get，內容對齊 v1 讀取流程且不指示未支援的寫入', async function () {
  const cases = [
    ['report-bug', { title: '登入逾時', project: 'OTHER' }],
    ['weekly-status', {}],
    ['triage-ticket', { ticketId: 'BUG-481' }],
    ['close-ticket', { ticketId: UUID }]
  ];

  for (const pair of cases) {
    const response = await rpc('prompts/get', { name: pair[0], arguments: pair[1] }, cfg(), neverFetch());
    assert.ok(!response.error, pair[0] + '：' + JSON.stringify(response.error));
    const text = response.result.messages[0].content.text;
    assert.ok(text.length > 0, pair[0] + ' 訊息不可為空');
    // 不得指示助手呼叫本版拿不到的寫入工具
    ['createTicket', 'updateField', 'addComment', 'transitionTicket', 'reassignTicket'].forEach(function (writeTool) {
      assert.ok(text.indexOf('呼叫 ' + writeTool) === -1,
        pair[0] + ' 不該指示呼叫未支援的 ' + writeTool);
    });
  }
});

test('report-bug 帶 project 時明講專案，triage 指名成員 UUID，close 以 getTransitions 的 actions 為準', async function () {
  const bug = await rpc('prompts/get', { name: 'report-bug', arguments: { title: 'T', project: 'OTHER' } }, cfg(), neverFetch());
  const bugText = bug.result.messages[0].content.text;
  assert.match(bugText, /OTHER/);
  assert.match(bugText, /litejira:\/\/meta/);
  assert.match(bugText, /不要嘗試用其他方式代為寫入/);

  const triage = await rpc('prompts/get', { name: 'triage-ticket', arguments: { ticketId: 'BUG-481' } }, cfg(), neverFetch());
  const triageText = triage.result.messages[0].content.text;
  assert.match(triageText, /UUID/);
  assert.match(triageText, /assigneeId/);
  assert.match(triageText, /litejira:\/\/ticket\/BUG-481/);

  const close = await rpc('prompts/get', { name: 'close-ticket', arguments: { ticketId: UUID } }, cfg(), neverFetch());
  const closeText = close.result.messages[0].content.text;
  assert.match(closeText, /getTransitions/);
  assert.match(closeText, /actions\[\]\.label/);
  assert.ok(closeText.indexOf(UUID) !== -1);

  const weekly = await rpc('prompts/get', { name: 'weekly-status', arguments: {} }, cfg(), neverFetch());
  assert.match(weekly.result.messages[0].content.text, /nextCursor/);
});

test('prompts/get 必填參數缺席仍然擋下', async function () {
  const response = await rpc('prompts/get', { name: 'triage-ticket', arguments: {} }, cfg(), neverFetch());
  assert.strictEqual(response.error.data.code, 'MISSING_PROMPT_ARGS');
});

// ── 全域：讀取路徑一發舊後端請求都沒有 ──

test('整個讀取面沒有任何一發請求走舊的 POST + body token', async function () {
  const calls = [];
  const fetchImpl = function (url, init) {
    calls.push({ url: url, init: init });
    return Promise.resolve({ status: 200, text: function () { return Promise.resolve('{"data":{}}'); } });
  };

  await callTool('litejira.searchTickets', {}, cfg(), fetchImpl);
  await callTool('litejira.listComments', { ticketId: '1' }, cfg(), fetchImpl);
  await callTool('litejira.getActivityLog', { ticketId: '1' }, cfg(), fetchImpl);
  await callTool('litejira.getTransitions', { ticketId: '1' }, cfg(), fetchImpl);
  for (const uri of ['litejira://meta', 'litejira://members', 'litejira://versions',
    'litejira://dashboard', 'litejira://workflow/BUG', 'litejira://ticket/1']) {
    await rpc('resources/read', { uri: uri }, cfg(), fetchImpl);
  }

  assert.strictEqual(calls.length, 10);
  calls.forEach(function (call) {
    assert.strictEqual(call.init.method, 'GET', call.url);
    assert.strictEqual(call.init.body, undefined, call.url);
    assert.ok(call.url.indexOf('/api/v1/') !== -1, call.url);
    assert.strictEqual(call.init.headers.Authorization, 'Bearer ' + TOKEN);
  });
});
