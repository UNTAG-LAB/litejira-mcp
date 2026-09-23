'use strict';

// GH-257 P4.2d / P5.6：補齊工單搜尋的完整查詢面（release-3.0.md「已知落差」那一段）。
//
// 後端把工單篩選擴成「12 個列舉維度 ×（是 / 不是）＋ 2 個文字維度 × 四個運算子
// ＋ overdue ＋ id」之後，MCP 只接了「是」那一組 ＋ q。缺的那些不是契約違反
//（白名單會當面拒絕，不存在「以為濾到了其實沒濾」），但呼叫端也**用不到**：
// 助手看不到參數、傳輸層擋下、CLI 沒有旗標。本檔鎖的就是補齊後的三件事：
//   1. 值域登錄表與後端 read-queries.ts / routes/ticket-filter.ts 逐字相同（不靠文件上的數字）
//   2. 工具 schema ↔ 傳輸層白名單 ↔ CLI 旗標三者一一對應（query mapping）
//   3. 新能力的正反例：送得出去、送出的形狀對、不合法的當面擋下、
//      以及跨專案（只帶 mine）時**一項都繞不過**後端的一般篩選限制
//
// 事實源（唯讀對照，不改後端工作樹）：
//   v2/server/src/api/v1/read-queries.ts        ENUM_FILTER_DIMS / TEXT_FILTER_DIMS / MINE_DIMS
//   v2/server/src/api/v1/routes/ticket-filter.ts 運算子欄展開、overdue 布林、TICKET_ID_FILTER_MAX
//   v2/server/src/api/v1/queries/tickets.ts      applyScope / generalFilterKeys（R-A15 一／三／四）
//
// 全部注入假 fetch，不接觸真 API、不讀憑證。

const test = require('node:test');
const assert = require('node:assert');

const { callTool, listTools } = require('../litejira-mcp-server');
const {
  ENUM_FILTER_DIMS,
  ENUM_FILTER_OPS,
  TEXT_FILTER_DIMS,
  TEXT_FILTER_OPS,
  TICKET_FILTER_FIELDS,
  TICKET_FILTER_UUID_FIELDS,
  TICKET_ID_FILTER_MAX,
  buildRequest,
  LiteJiraTransportError
} = require('../litejira-v1-transport');
const { parseCommand } = require('../ltj-cli');

const BASE = 'https://litejira.example.com';
const TOKEN = 'ltj_pat_test_abcdefgh';
const UUID = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';
const UUID2 = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';

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

// 送一次搜尋，回傳實際打出去的 URL 的 searchParams（驗的是「真的長成這樣」，不是內部狀態）。
async function search(args, config) {
  const fetchImpl = okFetch();
  await callTool('litejira.searchTickets', args, config || cfg(), fetchImpl);
  return new URL(fetchImpl.calls[0].url).searchParams;
}

// 每個維度給一個合法的樣本值：UUID 維度給 UUID，其餘給自由文字。
function sampleFor(field) {
  return TICKET_FILTER_UUID_FIELDS.indexOf(field) !== -1 ? UUID : '樣本值';
}

// ── 1. 登錄表 = 後端事實源 ──────────────────────────────────────────────

test('篩選維度登錄表逐字對上後端 read-queries.ts', function () {
  // 後端 ENUM_FILTER_DIMS（12 欄，順序照抄）
  assert.deepStrictEqual(ENUM_FILTER_DIMS.slice(), [
    'type', 'status', 'statusGroup', 'priority', 'module', 'subtype',
    'targetVersion', 'foundVersion', 'assigneeId', 'creatorId', 'ownerId', 'parentId'
  ]);
  // 後端 TEXT_FILTER_DIMS（2 欄）
  assert.deepStrictEqual(TEXT_FILTER_DIMS.slice(), ['title', 'description']);
  // 運算子：列舉維度兩個、文字維度四個（routes/ticket-filter.ts 的兩個 for 迴圈）
  assert.deepStrictEqual(ENUM_FILTER_OPS.slice(), ['', 'Not']);
  assert.deepStrictEqual(TEXT_FILTER_OPS.slice(), ['', 'Not', 'Contains', 'NotContains']);
  // 欄位數由維度 × 運算子推導，不是抄一個數字：12×2 + 2×4 = 32
  assert.strictEqual(TICKET_FILTER_FIELDS.length,
    ENUM_FILTER_DIMS.length * ENUM_FILTER_OPS.length +
    TEXT_FILTER_DIMS.length * TEXT_FILTER_OPS.length);
  assert.strictEqual(TICKET_FILTER_FIELDS.length, 32);
  // id 的上界與後端 TICKET_ID_FILTER_MAX 同一個數字
  assert.strictEqual(TICKET_ID_FILTER_MAX, 50);
});

test('文字維度才有 Contains；列舉維度沒有（送出去會 422，本機先擋）', async function () {
  for (const bad of ['statusContains', 'typeNotContains', 'priorityContains']) {
    await assert.rejects(
      () => callTool('litejira.searchTickets', { [bad]: 'x' }, cfg(), neverFetch()),
      (err) => {
        assert.strictEqual(err.code, 'VALIDATION_FAILED');
        assert.match(err.message, /unknown parameter/);
        return true;
      },
      bad + ' 不該存在'
    );
  }
  // 反面：文字維度的四個運算子都在
  const props = searchDef().inputSchema.properties;
  for (const field of ['title', 'titleNot', 'titleContains', 'titleNotContains',
    'description', 'descriptionNot', 'descriptionContains', 'descriptionNotContains']) {
    assert.ok(props[field], field + ' 應在工具 schema 內');
  }
});

// ── 2. query mapping：工具 schema ↔ 傳輸層白名單 ↔ CLI 旗標 ─────────────

test('query mapping：32 個運算子欄 + overdue + id 在工具 schema 與傳輸層白名單一一對應', function () {
  const props = searchDef().inputSchema.properties;
  const allow = require('../litejira-v1-transport').ACTION_MAP.searchTickets.query.allow;

  // 每個篩選欄都要「工具看得到」且「傳輸層送得出去」——少一邊就是一條用不到的能力
  TICKET_FILTER_FIELDS.concat(['overdue', 'id']).forEach((field) => {
    assert.ok(props[field], '工具 schema 缺少 ' + field);
    assert.ok(allow.indexOf(field) !== -1, '傳輸層白名單缺少 ' + field);
  });

  // 反向：白名單裡不該有工具參數對不上的鍵（否則是只有繞過工具層才叫得到的隱藏參數）
  allow.forEach((key) => {
    assert.ok(props[key], '傳輸層允許 ' + key + ' 但工具 schema 沒有這個參數');
  });
  // 工具參數也不該有白名單外的（否則會在傳輸層被自己擋掉）
  Object.keys(props).forEach((key) => {
    assert.ok(allow.indexOf(key) !== -1, '工具 schema 有 ' + key + ' 但傳輸層不接受');
  });
});

test('query mapping：CLI 旗標涵蓋每一個篩選欄，且對到同名的查詢參數', function () {
  const argv = ['search', '--project', 'LTJ'];
  const expected = {};
  TICKET_FILTER_FIELDS.forEach((field) => {
    const flag = '--' + field.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    const value = sampleFor(field);
    argv.push(flag, value);
    expected[field] = value;
  });
  argv.push('--id', UUID, '--overdue', 'true');

  const parsed = parseCommand(argv);
  Object.keys(expected).forEach((field) => {
    assert.strictEqual(parsed.params[field], expected[field], 'CLI 沒有解析到 ' + field);
  });
  assert.strictEqual(parsed.params.id, UUID);
  assert.strictEqual(parsed.params.overdue, true);
});

// ── 3. 正例：每一欄都送得出去，形狀與後端解析一致 ────────────────────────

test('正例：32 個運算子欄逐欄送得出去，參數名逐字相同', async function () {
  for (const field of TICKET_FILTER_FIELDS) {
    const value = sampleFor(field);
    const params = await search({ [field]: value });
    assert.strictEqual(params.get(field), value, field + ' 沒有出現在查詢字串');
  }
});

test('正例：每一欄都收多值，展開成重複 query（聯集），不做逗號串接', async function () {
  const params = await search({ statusNot: ['已關閉', '已取消'], assigneeIdNot: [UUID, UUID2] });
  assert.deepStrictEqual(params.getAll('statusNot'), ['已關閉', '已取消']);
  assert.deepStrictEqual(params.getAll('assigneeIdNot'), [UUID, UUID2]);
  assert.strictEqual(params.get('statusNot').indexOf(','), -1);
});

test('正例：overdue 兩個布林值都送得出去（false 不是「沒帶」）', async function () {
  assert.strictEqual((await search({ overdue: true })).get('overdue'), 'true');
  assert.strictEqual((await search({ overdue: false })).get('overdue'), 'false');
});

test('正例：id 指名多張（重複 query），上限剛好 50 張放行', async function () {
  const ids = [];
  for (let i = 0; i < TICKET_ID_FILTER_MAX; i++) {
    ids.push('00000000-0000-4000-8000-' + String(i).padStart(12, '0'));
  }
  const params = await search({ id: ids });
  assert.deepStrictEqual(params.getAll('id'), ids);
});

test('正例：文字維度的四個運算子與 q 可同時帶（交集），彼此不互斥', async function () {
  const params = await search({
    q: '登入', titleContains: '閃退', descriptionNotContains: '[已知]',
    titleNot: '登入頁 crash', overdue: true
  });
  assert.strictEqual(params.get('q'), '登入');
  assert.strictEqual(params.get('titleContains'), '閃退');
  assert.strictEqual(params.get('descriptionNotContains'), '[已知]');
  assert.strictEqual(params.get('titleNot'), '登入頁 crash');
  assert.strictEqual(params.get('overdue'), 'true');
  assert.strictEqual(params.get('project'), 'LTJ');
});

// ── 4. 反例：不合法的輸入當面擋下，一發都不送 ───────────────────────────

test('反例：overdue 只收布林，"yes" / 1 一律本機拒絕（打錯字與明確指定要分得出來）', async function () {
  for (const bad of ['yes', 'true', 1, 0]) {
    const fetchImpl = neverFetch();
    await assert.rejects(
      () => callTool('litejira.searchTickets', { overdue: bad }, cfg(), fetchImpl),
      (err) => err.code === 'VALIDATION_FAILED',
      JSON.stringify(bad) + ' 不該被放行'
    );
    assert.strictEqual(fetchImpl.calls.length, 0);
  }
});

test('反例：成員 / 母單的「不是」版同樣只收 UUID，顯示名不放行', async function () {
  for (const field of ['assigneeIdNot', 'creatorIdNot', 'ownerIdNot', 'parentIdNot']) {
    const fetchImpl = neverFetch();
    await assert.rejects(
      () => callTool('litejira.searchTickets', { [field]: '思源' }, cfg(), fetchImpl),
      (err) => err.code === 'VALIDATION_FAILED',
      field + ' 不該接受顯示名'
    );
    assert.strictEqual(fetchImpl.calls.length, 0);
  }
});

test('反例：id 只收 UUID，公開 key / 數字 key 被擋（那兩種請逐張讀）', async function () {
  for (const bad of ['BUG-481', '481', ['BUG-481']]) {
    const fetchImpl = neverFetch();
    await assert.rejects(
      () => callTool('litejira.searchTickets', { id: bad }, cfg(), fetchImpl),
      (err) => err.code === 'VALIDATION_FAILED',
      JSON.stringify(bad) + ' 不該被放行'
    );
    assert.strictEqual(fetchImpl.calls.length, 0);
  }
});

test('反例：id 超過 50 張本機擋下並講出上限，不截斷成前 50 個', function () {
  const ids = [];
  for (let i = 0; i < TICKET_ID_FILTER_MAX + 1; i++) {
    ids.push('00000000-0000-4000-8000-' + String(i).padStart(12, '0'));
  }
  // 工具層先擋（schema 的 maxItems）
  assert.strictEqual(searchDef().inputSchema.properties.id.maxItems, TICKET_ID_FILTER_MAX);
  // 傳輸層也自己擋一次：繞過工具層直接叫 action 一樣不放行
  assert.throws(
    () => buildRequest({
      baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: { project: 'LTJ', id: ids }
    }),
    (err) => {
      assert.ok(err instanceof LiteJiraTransportError);
      assert.strictEqual(err.code, 'invalid_argument');
      assert.strictEqual(err.details.param, 'id');
      assert.strictEqual(err.details.max, TICKET_ID_FILTER_MAX);
      assert.strictEqual(err.details.count, TICKET_ID_FILTER_MAX + 1);
      return true;
    }
  );
});

test('反例：文字條件不收空字串（後端會靜默當成沒指定，本機當面擋下）', async function () {
  for (const field of ['titleContains', 'descriptionContains', 'statusNot', 'q']) {
    const fetchImpl = neverFetch();
    await assert.rejects(
      () => callTool('litejira.searchTickets', { [field]: '' }, cfg(), fetchImpl),
      (err) => err.code === 'VALIDATION_FAILED',
      field + '="" 不該被當成「沒指定」靜默吃掉'
    );
    assert.strictEqual(fetchImpl.calls.length, 0);
  }
});

// ── 5. 跨專案：新能力一項都繞不過 R-A15 四 ──────────────────────────────

test('跨專案（只帶 mine）時，每一個新篩選能力都被當面拒絕，一發都不送', async function () {
  const cases = TICKET_FILTER_FIELDS.map((field) => ({ [field]: sampleFor(field) }));
  cases.push({ overdue: true }, { overdue: false }, { id: UUID }, { q: '登入' });

  for (const extra of cases) {
    const fetchImpl = neverFetch();
    await assert.rejects(
      () => callTool('litejira.searchTickets',
        Object.assign({ mine: 'assignee' }, extra), cfg({ project: '' }), fetchImpl),
      (err) => {
        assert.match(err.message, /跨專案查詢/);
        assert.match(err.message, /不接受一般篩選/);
        // 指路：講出是哪一個條件在衝突（後端 generalFilterKeys 也是這樣回）
        assert.deepStrictEqual(err.details.conflicting, Object.keys(extra));
        return true;
      },
      JSON.stringify(extra) + ' 應被擋下'
    );
    assert.strictEqual(fetchImpl.calls.length, 0);
  }
});

test('跨專案守門在傳輸層也成立（繞過工具層直接叫 action 一樣擋）', function () {
  assert.throws(
    () => buildRequest({
      baseUrl: BASE, token: TOKEN, action: 'searchTickets',
      params: { mine: 'watcher', overdue: true }
    }),
    (err) => {
      assert.strictEqual(err.code, 'invalid_argument');
      assert.deepStrictEqual(err.details.conflicting, ['overdue']);
      return true;
    }
  );
});

test('跨專案 + 明確帶 project 時，新篩選照常成立（縮小，不放寬）', async function () {
  const params = await search(
    { project: 'OTHER', mine: 'assignee', statusNot: '已關閉', overdue: true },
    cfg({ project: '' }));
  assert.strictEqual(params.get('project'), 'OTHER');
  assert.strictEqual(params.get('mine'), 'assignee');
  assert.strictEqual(params.get('statusNot'), '已關閉');
  assert.strictEqual(params.get('overdue'), 'true');
});

test('CLI：跨專案時新篩選旗標同樣被擋，且不套用 LTJ_PROJECT 預設', async function () {
  const { runCli } = require('../ltj-cli');
  const env = { LTJ_API_URL: BASE, LTJ_API_TOKEN: TOKEN, LTJ_PROJECT: 'MAIN' };
  const io = { log() {}, error() {} };
  const sent = [];
  const fetchImpl = async (url) => {
    sent.push(new URL(url));
    return { status: 200, text: async () => JSON.stringify({ data: { items: [], nextCursor: null } }) };
  };
  // 本機拒絕 → exit 2，且沒有任何請求送出
  assert.strictEqual(
    await runCli(['search', '--mine', 'assignee', '--overdue', 'true'], env, io, fetchImpl), 2);
  assert.strictEqual(
    await runCli(['search', '--mine', 'assignee', '--status-not', '已關閉'], env, io, fetchImpl), 2);
  assert.strictEqual(sent.length, 0);

  // 有專案（這裡靠 LTJ_PROJECT）時同樣的條件就成立
  assert.strictEqual(await runCli(['search', '--overdue', 'true', '--status-not', '已關閉'],
    env, io, fetchImpl), 0);
  assert.strictEqual(sent[0].searchParams.get('project'), 'MAIN');
  assert.strictEqual(sent[0].searchParams.get('overdue'), 'true');
  assert.strictEqual(sent[0].searchParams.get('statusNot'), '已關閉');
});

test('CLI：--overdue 打錯字不被當成 false，而是往下送給傳輸層當面拒絕', async function () {
  const { runCli } = require('../ltj-cli');
  const env = { LTJ_API_URL: BASE, LTJ_API_TOKEN: TOKEN, LTJ_PROJECT: 'MAIN' };
  const errors = [];
  const io = { log() {}, error: (line) => errors.push(line) };
  const fetchImpl = async () => { throw new Error('不應送出任何請求'); };
  assert.strictEqual(await runCli(['search', '--overdue', 'yes'], env, io, fetchImpl), 2);
  assert.match(errors.join('\n'), /overdue/);
  assert.strictEqual(parseCommand(['search', '--overdue', 'yes']).params.overdue, 'yes');
  assert.strictEqual(parseCommand(['search', '--overdue', 'false']).params.overdue, false);
});

// ── 6. 說明要講得出新能力（否則助手仍然不會用）────────────────────────────

test('工具說明與啟動 instructions 講出「不是 / 包含 / 逾期 / 指名」四類能力', async function () {
  const def = searchDef();
  assert.match(def.description, /append "Not"/);
  assert.match(def.description, /Contains \/ NotContains/);
  assert.match(def.description, /overdue=true\|false/);
  assert.match(def.description, /id=<uuid>/);
  // 「不是」會撈到該欄為空的單 —— 這是呼叫端一定會誤判的一條，說明要寫出來
  assert.match(def.inputSchema.properties.assigneeIdNot.description, /未指派|為空/);

  const { handleJsonRpcRequest } = require('../litejira-mcp-server');
  const res = await handleJsonRpcRequest(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, cfg(), neverFetch());
  // instructions 有 GH-265 的字數預算，所以只點名運算子、細節留在 schema。
  assert.match(res.result.instructions, /XNot/);
  assert.match(res.result.instructions, /XContains\/XNotContains/);
  assert.match(res.result.instructions, /overdue/);
  // GH-317：預算維持 1000，附件那一行擠進既有額度；細節仍由工具 schema 承載。
  assert.ok(res.result.instructions.length <= 1000, '預算仍須成立：' + res.result.instructions.length);
});
