'use strict';

// GH-313：3.0.0 發版前的契約漂移回歸。
//
// 本檔鎖的是「MCP 的說明 / 值域 / 本機守門與後端 v1 真契約不一致」這一類缺陷 ——
// 它們不會讓任何測試變紅，只會讓助手照著錯的說明去打一發必定失敗（或必定被本機誤擋）的請求。
// 三個靶：
//   1. searchTickets 的專案必填（後端 queries/tickets.ts `applyScope`，R-A15 一／三／四）
//   2. sort 的值域（後端 contracts/src/ticket-fields.ts 的 `TICKET_FIELDS.sortable`，15 欄）
//   3. 前進流轉「main不受影響」也必填 reason（後端 queries/ticket-writes.ts `REASON_REQUIRED_FORWARD`）
//
// 全部注入假 fetch，不接觸真 API、不讀憑證。

const test = require('node:test');
const assert = require('node:assert');

const { callTool, handleJsonRpcRequest, listTools } = require('../litejira-mcp-server');
const { MINE_VALUES, SORT_VALUES, buildRequest, LiteJiraTransportError } =
  require('../litejira-v1-transport');

const BASE = 'https://litejira.example.com';
const TOKEN = 'ltj_pat_test_abcdefgh';
const UUID = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';

function cfg(extra) {
  return Object.assign({ apiUrl: BASE, token: TOKEN, project: 'LTJ', enableWrites: true }, extra || {});
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

function neverFetch() {
  const calls = [];
  const fetchImpl = function () {
    calls.push(arguments);
    throw new Error('不應送出任何請求');
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function searchDef() {
  return listTools().find((t) => t.name === 'litejira.searchTickets');
}

// ── 靶 1：專案必填 ──────────────────────────────────────────────────────

test('GH-313：searchTickets 的說明不再宣稱「不帶 project 就是跨專案搜尋」', function () {
  const def = searchDef();
  // 舊說明的核心錯誤是「兩者皆無則不帶此條件（跨專案搜尋）」。
  assert.ok(!/跨專案搜尋/.test(def.inputSchema.properties.project.description),
    'project 的說明仍在宣稱可以跨專案搜尋：' + def.inputSchema.properties.project.description);
  assert.match(def.inputSchema.properties.project.description, /必填/);
  // 正面陳述也要在：必填 + 唯一跨專案入口是 mine + 跨專案不接受其他篩選。
  assert.match(def.description, /PROJECT IS MANDATORY/);
  assert.match(def.description, /mine=assignee\|creator\|watcher/);
  assert.match(def.description, /NO other filter/);
});

test('GH-313：缺 project 且缺 LTJ_PROJECT 時本機擋下，一發都不送', async function () {
  const fetchImpl = neverFetch();
  await assert.rejects(
    () => callTool('litejira.searchTickets', { q: 'crash' }, cfg({ project: '' }), fetchImpl),
    (err) => {
      assert.strictEqual(err.code, 'PROJECT_REQUIRED');
      // 指路：要補什麼、跨專案該怎麼寫，都要講出來，不是只回一句「缺參數」。
      assert.match(err.message, /LTJ_PROJECT/);
      assert.match(err.message, /mine=assignee \| creator \| watcher/);
      return true;
    }
  );
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test('GH-313：傳輸層自己也守（繞過工具層直接呼叫 action 一樣擋）', function () {
  assert.throws(
    () => buildRequest({ baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: { q: 'x' } }),
    (err) => {
      assert.ok(err instanceof LiteJiraTransportError);
      assert.strictEqual(err.code, 'invalid_argument');
      assert.strictEqual(err.details.param, 'project');
      return true;
    }
  );
});

test('GH-313：mine 是唯一的跨專案入口，且不套用 LTJ_PROJECT 預設', async function () {
  const def = searchDef();
  assert.deepStrictEqual(def.inputSchema.properties.mine.enum, ['assignee', 'creator', 'watcher']);
  assert.deepStrictEqual(MINE_VALUES.slice(), ['assignee', 'creator', 'watcher']);

  // 只帶 mine：即使 LTJ_PROJECT=LTJ 也不偷偷收斂成單一專案（那會回一份比要求更窄的清單）。
  const fetchImpl = okFetch({ items: [], nextCursor: null });
  await callTool('litejira.searchTickets', { mine: 'assignee' }, cfg(), fetchImpl);
  const url = fetchImpl.calls[0].url;
  assert.ok(url.indexOf('mine=assignee') !== -1, url);
  assert.ok(url.indexOf('project=') === -1, '不該自動補上 LTJ_PROJECT：' + url);
});

test('GH-313：project + mine 併用＝縮小到那個專案裡我的那些', async function () {
  const fetchImpl = okFetch({ items: [], nextCursor: null });
  await callTool('litejira.searchTickets', { project: 'OTHER', mine: 'watcher' }, cfg(), fetchImpl);
  const url = fetchImpl.calls[0].url;
  assert.ok(url.indexOf('project=OTHER') !== -1, url);
  assert.ok(url.indexOf('mine=watcher') !== -1, url);
});

test('GH-313：跨專案（只帶 mine）時一般篩選被當面拒絕，不是靜默忽略', async function () {
  for (const extra of [{ q: 'crash' }, { status: '開發中' }, { assigneeId: UUID }, { type: ['BUG'] }]) {
    const fetchImpl = neverFetch();
    await assert.rejects(
      () => callTool('litejira.searchTickets',
        Object.assign({ mine: 'creator' }, extra), cfg({ project: '' }), fetchImpl),
      (err) => {
        // 傳輸層的本機拒絕：code 與後端錯誤碼刻意同名（invalid_argument），但走的是 -32000 通道。
        assert.match(err.message, /跨專案查詢/);
        assert.match(err.message, /不接受一般篩選/);
        return true;
      },
      JSON.stringify(extra)
    );
    assert.strictEqual(fetchImpl.calls.length, 0);
  }
});

test('GH-313：跨專案時排序與分頁仍可帶（它們不改變框到哪些單）', async function () {
  const fetchImpl = okFetch({ items: [], nextCursor: null });
  await callTool('litejira.searchTickets',
    { mine: 'assignee', sort: 'dueDate', order: 'asc', limit: 20 }, cfg({ project: '' }), fetchImpl);
  const url = fetchImpl.calls[0].url;
  assert.ok(url.indexOf('mine=assignee') !== -1, url);
  assert.ok(url.indexOf('sort=dueDate') !== -1, url);
  assert.ok(url.indexOf('limit=20') !== -1, url);
});

test('GH-313：啟動 instructions 講明搜尋的專案必填與跨專案限制', async function () {
  const res = await handleJsonRpcRequest(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, cfg(), neverFetch());
  const instructions = res.result.instructions;
  assert.match(instructions, /searchTickets 的 project 必填/);
  assert.match(instructions, /mine=assignee\|creator\|watcher/);
});

// ── 靶 2：sort 值域 ─────────────────────────────────────────────────────

test('GH-313：sort 值域＝後端登錄表的 15 個可排序欄位，工具與傳輸層同一份', function () {
  const expected = [
    'updatedAt', 'createdAt', 'key', 'type', 'title', 'status', 'priority',
    'assignee', 'owner', 'creator', 'module', 'targetVersion', 'foundVersion',
    'startDate', 'dueDate'
  ];
  assert.deepStrictEqual(SORT_VALUES.slice(), expected);
  assert.deepStrictEqual(searchDef().inputSchema.properties.sort.enum, expected);
});

test('GH-313：契約內的 sort 值全部送得出去（舊版只認三個是漏抄）', async function () {
  for (const field of SORT_VALUES) {
    const fetchImpl = okFetch({ items: [], nextCursor: null });
    await callTool('litejira.searchTickets', { sort: field }, cfg(), fetchImpl);
    assert.ok(fetchImpl.calls[0].url.indexOf('sort=' + field) !== -1,
      field + ' 應可送出：' + fetchImpl.calls[0].url);
  }
});

test('GH-313：登錄表標為不可排序的欄位仍被擋（不打出伺服器會 422 的查詢）', async function () {
  for (const field of ['id', 'tags', 'parent', 'stateGroup', 'subtype', 'watchers']) {
    await assert.rejects(
      () => callTool('litejira.searchTickets', { sort: field }, cfg(), neverFetch()),
      (err) => err.code === 'VALIDATION_FAILED',
      field + ' 不該被放行'
    );
  }
});

// ── 靶 3：前進流轉的 reason（#313）────────────────────────────────────────

test('GH-313：流轉工具講明「main不受影響」這個前進動作也必填 reason', function () {
  const tools = listTools();
  const single = tools.find((t) => t.name === 'litejira.transitionTicket');
  const batch = tools.find((t) => t.name === 'litejira.batchTransition');
  const reply = tools.find((t) => t.name === 'litejira.replyFeedback');

  // 舊說明只講「退回類動作要帶 reason」，會讓助手在熱修回 main 那一步漏帶而撞 422。
  assert.match(single.description, /main不受影響/);
  assert.match(single.inputSchema.properties.reason.description, /main不受影響/);
  assert.match(batch.inputSchema.properties.reason.description, /main不受影響/);
  assert.match(reply.inputSchema.properties.transition.description, /main不受影響/);
});

test('GH-313：帶了 reason 的前進流轉照常送出（本機不自作主張預判動作方向）', async function () {
  // 「這個動作要不要 reason」是資料相關的判定（要先知道動作的 direction），住在後端。
  // 本層只負責把說明講對，不在客戶端複製一份動作表 —— 複製的那份一定會過時。
  const fetchImpl = okFetch({ id: UUID, key: 'BUG-481', status: '待發布' });
  await callTool('litejira.transitionTicket', {
    ticketId: 'BUG-481',
    action: 'main不受影響',
    reason: '此修復只動到 hotfix 分支的設定檔',
    idempotencyKey: 'gh313transitionkey0001'
  }, cfg(), fetchImpl);
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.strictEqual(body.action, 'main不受影響');
  assert.strictEqual(body.reason, '此修復只動到 hotfix 分支的設定檔');
});
