'use strict';

// GH-360：工單參照的教學與 not_found 指引。
//
// 報案情境：呼叫端拿「類型 REQ」＋「編號 2229」自行拼成 `REQ-2229` 去讀工單，後端回 404 not_found。
// 既定裁決（後端 R-T04）：key 不帶類型語意 —— 新單的 key 就是純數字，舊單保留原始編號，
// 而且**類型轉換不改編號**，所以一張 key 為 `BUG-1205` 的單今天完全可能是 REQ。
//
// 因此本包只改「說明與事後指引」，而且刻意**不做**這些事（這支測試同時是它們的反向保護）：
//   - 不收緊 TICKET_REF_PATTERN（會誤擋真實舊式 key）
//   - 不在客戶端拿前綴核對當前 type（同上，而且那就是「以前綴推類型」）
//   - 不自動 fallback（剝掉前綴改送一次）：存在性只有後端知道，客戶端猜一次就可能打到別張單
//
// 前半段用假 fetch 驗字面與**請求發數**；後半段 spawn 真的 stdio 伺服器跑 JSON-RPC。

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  callTool,
  handleJsonRpcRequest,
  listTools
} = require('../litejira-mcp-server');

const BASE = 'https://litejira.example.com';
const V1 = BASE + '/api/v1';
const TOKEN = 'ltj_pat_test_abcdefgh';
const UUID = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';

function cfg(extra) {
  return Object.assign({
    apiUrl: BASE,
    token: TOKEN,
    project: 'LTJ',
    enableWrites: false
  }, extra || {});
}

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

function okFetch(data) { return recorder({ data: data }); }
function errFetch(status, error) { return recorder({ error: error }, status); }

function rpc(method, params, config, fetchImpl) {
  return handleJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: method, params: params },
    config, fetchImpl);
}

// 工具的錯誤走 isError + content[0].text；取出 💡 之後的指引全文。
function hintFromTool(result) {
  const text = result.content[0].text;
  const marker = '💡 ';
  const at = text.indexOf(marker);
  return at === -1 ? '' : text.slice(at + marker.length);
}

async function notFoundHintForTool(ref, code) {
  const fetchImpl = errFetch(404, { code: code || 'not_found', message: '找不到' });
  const result = await callTool('litejira.getTransitions', { ticketId: ref }, cfg(), fetchImpl);
  assert.ok(result.isError, ref + ' 應該是 isError');
  assert.strictEqual(fetchImpl.calls.length, 1, ref + '：not_found 後不得再送第二發（禁止自動 fallback）');
  assert.strictEqual(fetchImpl.calls[0].url, V1 + '/tickets/' + ref + '/transitions');
  return hintFromTool(result);
}

// ── T2 / T3 / T4：三種形狀直通，一發就是一發 ──

test('GH-360：UUID／純數字／真實舊式 key 都原樣進路徑，各只送一發', async () => {
  for (const ref of [UUID, '2229', '481', 'BUG-1205', 'BUG-481']) {
    const toolFetch = okFetch({ actions: [], transitions: [] });
    const result = await callTool('litejira.getTransitions', { ticketId: ref }, cfg(), toolFetch);
    assert.ok(!result.isError, ref + ' 不該被客戶端擋下：' + JSON.stringify(result.content));
    assert.strictEqual(toolFetch.calls.length, 1, ref + ' 應該剛好一發');
    assert.strictEqual(toolFetch.calls[0].url, V1 + '/tickets/' + ref + '/transitions');

    const resFetch = okFetch({ id: UUID, key: ref });
    const response = await rpc('resources/read', { uri: 'litejira://ticket/' + ref }, cfg(), resFetch);
    assert.strictEqual(response.error, undefined, ref + ' 的 resource 不該出錯');
    assert.strictEqual(resFetch.calls.length, 1);
    assert.strictEqual(resFetch.calls[0].url, V1 + '/tickets/' + ref);
  }
});

// ── T5：真實舊式 key，而該單現在的類型已經不是前綴那個字 ──

test('GH-360：舊式 key 的前綴與當前類型不符時，客戶端不報錯也不改寫參照', async () => {
  const fetchImpl = okFetch({ id: UUID, key: 'BUG-1205', type: 'REQ', title: '已轉型的舊單' });
  const result = await callTool('litejira.listComments', { ticketId: 'BUG-1205' }, cfg(), fetchImpl);
  assert.ok(!result.isError, '前綴與 type 不符不是客戶端該管的事');
  assert.strictEqual(fetchImpl.calls.length, 1);
  assert.strictEqual(fetchImpl.calls[0].url, V1 + '/tickets/BUG-1205/comments');
});

// ── T6 / T7：合成前綴 ──

test('GH-360：合成前綴仍照常送出（pattern 不收緊），not_found 才補指引', async () => {
  const fetchImpl = errFetch(404, { code: 'not_found', message: '找不到' });
  const result = await callTool('litejira.getTransitions', { ticketId: 'REQ-2229' }, cfg(), fetchImpl);
  assert.strictEqual(fetchImpl.calls.length, 1, '不得自動改送第二個參照');
  assert.strictEqual(fetchImpl.calls[0].url, V1 + '/tickets/REQ-2229/transitions');

  const hint = hintFromTool(result);
  assert.match(hint, /REQ-2229/);
  assert.match(hint, /litejira\.searchTickets/);
  assert.match(hint, /核對/);              // 反查之後要核對回傳的 key／id，不是看到就用
  assert.match(hint, /純數字/);            // 新單的 key 是純數字這件事要講明
  // 指引不得宣告存在性：必須明講這個碼分不出「不存在／無權限／已軟刪除」，而不是斷定不存在。
  assert.match(hint, /不證明目標確實不存在/);
  assert.match(hint, /不可分辨/);
  assert.doesNotMatch(hint, /確定不存在|一定不存在|這張單不存在|你沒有這張單/);
  // 條件措辭：那一段只能是「一般提醒」，不能寫成本次失敗的判定。
  assert.match(hint, /不是本次失敗的判定/);
  // 也不得叫人直接剝前綴重試（那是另一種猜）。
  assert.match(hint, /不要自行改寫參照/);
  assert.match(hint, /不要逕自拿掉前綴再送一次/);
});

// ── 不實絕對斷言的攔截：這是本次退修的核心，任何面向使用者的字串都不得出現 ──

test('GH-360：任何說明／指引都不得斷言「那不是任何一張單的 key」', async () => {
  const fs = require('node:fs');
  const banned = /(不是|不會是)任何一張單的\s*key|never a real ticket key|is not any ticket's key/i;

  // 1) 執行期產出的文字：工具說明、資源模板、prompt、initialize instructions、not_found 指引。
  const surfaces = [];
  for (const t of listTools()) surfaces.push(t.name + ':' + JSON.stringify(t));
  surfaces.push(JSON.stringify((await rpc('resources/templates/list', {}, cfg(), null)).result));
  surfaces.push(JSON.stringify((await rpc('prompts/list', {}, cfg(), null)).result));
  for (const name of ['weekly-status', 'triage-ticket', 'close-ticket']) {
    const got = await rpc('prompts/get', { name: name, arguments: { ticketId: '2229' } }, cfg(), null);
    assert.strictEqual(got.error, undefined, name + ' 應該取得到：' + JSON.stringify(got.error));
    surfaces.push(JSON.stringify(got.result));
  }
  surfaces.push((await handleJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).result.instructions);
  surfaces.push(await notFoundHintForTool('REQ-2229'));

  // 2) 文件：README 與本包的設計筆記也在同一條規則下。
  for (const rel of ['README.md', 'docs/GH-257/pack2-mcp-read.md']) {
    surfaces.push(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
  }

  for (const text of surfaces) {
    assert.doesNotMatch(text, banned,
      '出現不實的絕對斷言（真的有一張 key 為 REQ-2229 的舊單完全可能存在）：' +
      String(text).slice(0, 160));
  }

  // 反面：正確的正面措辭要真的講出來，否則上面的 doesNotMatch 可以靠「整段刪掉」通過。
  const desc = listTools().find(function (t) { return t.name === 'litejira.getTransitions'; });
  assert.match(JSON.stringify(desc), /server-returned key verbatim/);
  const template = (await rpc('resources/templates/list', {}, cfg(), null)).result.resourceTemplates
    .find(function (t) { return t.uriTemplate === 'litejira://ticket/{id}'; });
  assert.match(template.description, /key 不能據類型推得/);
});

// ── 真實存在的 REQ-2229（當前 type 已是 BUG）：成功反例 ──

test('GH-360：真有一張 key 為 REQ-2229 的舊單（現在是 BUG）時，照常讀得到，客戶端不干涉', async () => {
  // 轉換類型不改編號，所以「前綴 REQ、type BUG」是後端允許的真實狀態。
  const ticket = { id: UUID, key: 'REQ-2229', type: 'BUG', title: '轉成 BUG 的舊 REQ' };

  const toolFetch = okFetch({ actions: [{ label: '開始開發' }], transitions: [] });
  const tool = await callTool('litejira.getTransitions', { ticketId: 'REQ-2229' }, cfg(), toolFetch);
  assert.ok(!tool.isError, '合成形狀與真實 key 在客戶端無從分辨，絕不能被擋下');
  assert.strictEqual(toolFetch.calls.length, 1);
  assert.strictEqual(toolFetch.calls[0].url, V1 + '/tickets/REQ-2229/transitions');

  const resFetch = okFetch(ticket);
  const response = await rpc('resources/read', { uri: 'litejira://ticket/REQ-2229' }, cfg(), resFetch);
  assert.strictEqual(response.error, undefined);
  assert.deepStrictEqual(JSON.parse(response.result.contents[0].text), ticket);
  assert.strictEqual(resFetch.calls.length, 1);
  assert.strictEqual(resFetch.calls[0].url, V1 + '/tickets/REQ-2229');
});

test('GH-360：前綴與工單實際類型不符時，not_found 指引逐字相同（不以前綴推類型）', async () => {
  const a = await notFoundHintForTool('REQ-2229');
  const b = await notFoundHintForTool('BUG-2229');
  assert.strictEqual(
    a.split('REQ-2229').join('<REF>'),
    b.split('BUG-2229').join('<REF>'),
    '兩者只能差在被引用的參照字面，其餘一字不能不同');
});

// ── T8 / T10：純數字找不到 / 軟刪除 ──

test('GH-360：純數字找不到與軟刪除回應逐字相同，且不帶前綴那一段', async () => {
  const missing = await notFoundHintForTool('999999999');
  const deleted = await notFoundHintForTool('2229');   // 後端對軟刪除單同樣回 404 not_found
  assert.strictEqual(
    missing.split('999999999').join('<REF>'),
    deleted.split('2229').join('<REF>'),
    '不存在與已刪除必須不可分辨：除了被引用的參照字面，一字不能不同');
  assert.doesNotMatch(missing, /前綴/, '純數字參照不該被講前綴問題');
  assert.doesNotMatch(missing, /確定不存在|一定不存在/);
  assert.match(missing, /不證明目標確實不存在/);
  assert.match(missing, /litejira\.searchTickets/);
  assert.match(missing, /不要自行改寫參照/, '禁止自行拼／剝前綴的規則對純數字參照一樣適用');
});

// ── T9：ACL 類錯誤不被工單參照指引污染 ──

test('GH-360：ACL 類錯誤的指引不談工單參照格式（mock 後端，非真實 ACL 實測）', async () => {
  for (const code of ['membership_required', 'permission_denied']) {
    const hint = await notFoundHintForTool('REQ-2229', code);
    assert.doesNotMatch(hint, /前綴/, code + ' 不該出現工單參照指引');
    assert.match(hint, /admin/);
  }
});

// ── 多參照的 404：不得歸因、更不得叫人去改一個原本正確的參照 ──

test('GH-360：linkTickets 的 404 可能是父工單，指引不得把矛頭指向原本正確的 childId', async () => {
  // childId 是真實舊式 key（正確），parentId 是一個查不到的 UUID —— 404 只有一個，後端不說是哪一個。
  const fetchImpl = errFetch(404, { code: 'not_found', message: '找不到' });
  const result = await callTool('litejira.linkTickets', {
    childId: 'BUG-1205',
    parentId: '00000000-0000-4000-8000-000000000000',
    idempotencyKey: 'gh360-link-key-00001'
  }, cfg({ enableWrites: true }), fetchImpl);

  assert.ok(result.isError);
  assert.strictEqual(fetchImpl.calls.length, 1, '不得為了「試試看是哪一個」多打一發');

  const hint = hintFromTool(result);
  assert.match(hint, /子工單「BUG-1205」/);
  assert.match(hint, /父工單「00000000-0000-4000-8000-000000000000」/);
  assert.match(hint, /回應不指出是哪一個對不上/);
  assert.match(hint, /不要只憑這一句就改掉其中你已經核對過的那一個/);
  // 最關鍵的一條：不得出現「把 BUG-1205 改掉」這種無條件引導；
  // 「拿掉前綴」只能出現在「請原樣保留、不要拿掉」的否定句裡。
  assert.match(hint, /若它本來就是伺服器給的 key，請原樣保留，不要逕自拿掉前綴再送一次/);
  assert.doesNotMatch(hint, /請(把|將).*改成|改用不帶前綴|請改送純數字|先試試拿掉前綴/);
});

test('GH-360：removeTicketLink 的 404 可能是連結本身，指引把工單與連結都列出來', async () => {
  const fetchImpl = errFetch(404, { code: 'not_found', message: '找不到' });
  const result = await callTool('litejira.removeTicketLink', {
    ticketId: '2229',
    linkId: '11111111-2222-4333-8444-555555555555',
    idempotencyKey: 'gh360-link-key-00002'
  }, cfg({ enableWrites: true }), fetchImpl);

  assert.ok(result.isError);
  assert.strictEqual(fetchImpl.calls.length, 1, 'not_found 後不得回頭重讀或重試');

  const hint = hintFromTool(result);
  assert.match(hint, /工單「2229」/);
  assert.match(hint, /連結「11111111-2222-4333-8444-555555555555」/);
  assert.match(hint, /回應不指出是哪一個對不上/);
  // 兩個參照都不是「字母前綴-數字」形狀 → 不該冒出前綴那一段。
  assert.doesNotMatch(hint, /前綴/);
});

// ── 批次：逐張 failed[] 也要拿到同一段指引，且不污染其他錯誤與 succeeded[] ──

test('GH-360：批次 failed[] 的 not_found 補上同一段指引，其餘欄位一字不動', async () => {
  const succeeded = [{ ticket: '2229', id: UUID, key: '2229', status: '開發中', assignee: null }];
  const fetchImpl = okFetch({
    succeeded: succeeded,
    failed: [
      { ticket: 'REQ-2229', error: { code: 'not_found', message: '工單不存在', details: { ticket: 'REQ-2229' } } },
      { ticket: '777', error: { code: 'permission_denied', message: '權限不足' } }
    ]
  });
  const result = await callTool('litejira.batchTransition', {
    tickets: ['2229', 'REQ-2229', '777'],
    action: '開始開發',
    idempotencyKey: 'gh360-batch-key-0001'
  }, cfg({ enableWrites: true }), fetchImpl);

  assert.ok(!result.isError, '部分成功仍是 200，不是 isError');
  assert.strictEqual(fetchImpl.calls.length, 1, '批次就是一發，失敗那幾張不得被改送單筆');

  const data = result.structuredContent;
  assert.deepStrictEqual(data.succeeded, succeeded, 'succeeded[] 不得被重包或加料');
  assert.deepStrictEqual(JSON.parse(result.content[0].text), data, 'text 與 structuredContent 必須同一份');

  const missing = data.failed[0];
  assert.strictEqual(missing.ticket, 'REQ-2229');
  assert.strictEqual(missing.error.code, 'not_found');
  assert.strictEqual(missing.error.message, '工單不存在', '後端原文不得被改寫');
  assert.deepStrictEqual(missing.error.details, { ticket: 'REQ-2229' });
  assert.strictEqual(missing.error.hint, await notFoundHintForTool('REQ-2229'),
    '批次與單筆必須是逐字相同的同一段指引');

  // 其他錯誤碼不被污染：既不加 hint，也不多出任何鍵。
  assert.deepStrictEqual(data.failed[1], { ticket: '777', error: { code: 'permission_denied', message: '權限不足' } });
});

test('GH-360：批次沒有 not_found 時回應原樣轉出（不為了加欄位而重包）', async () => {
  const payload = {
    succeeded: [{ ticket: '2229', id: UUID, key: '2229', status: '完成', assignee: null }],
    failed: [{ ticket: '777', error: { code: 'invalid_argument', message: '動作不合法' } }]
  };
  const fetchImpl = okFetch(payload);
  const result = await callTool('litejira.batchTransition', {
    tickets: ['2229', '777'], action: '開始開發', idempotencyKey: 'gh360-batch-key-0002'
  }, cfg({ enableWrites: true }), fetchImpl);
  assert.strictEqual(fetchImpl.calls.length, 1);
  assert.deepStrictEqual(result.structuredContent, payload);
});

// ── 複合工具：replyFeedback 的步驟錯誤也共用同一段指引，部分成功語意不變 ──

test('GH-360：replyFeedback 第一步 not_found 時補指引，step／applied／已完成清單語意不變', async () => {
  const fetchImpl = errFetch(404, { code: 'not_found', message: '工單不存在', details: { ticket: 'REQ-2229' } });
  const result = await callTool('litejira.replyFeedback', {
    ticketId: 'REQ-2229',
    content: '收到',
    transition: { action: '開始開發' },
    idempotencyKey: 'gh360-reply-key-0001'
  }, cfg({ enableWrites: true }), fetchImpl);

  assert.ok(result.isError);
  assert.strictEqual(fetchImpl.calls.length, 1,
    '第一步失敗就不送留言，也不得為了確認工單而多打一發');

  const payload = result.structuredContent;
  assert.strictEqual(payload.error.code, 'not_found');
  assert.strictEqual(payload.error.message, '工單不存在');
  assert.deepStrictEqual(payload.error.details, { ticket: 'REQ-2229' });
  assert.strictEqual(payload.error.hint, await notFoundHintForTool('REQ-2229'));
  // 複合語意原封不動。
  assert.strictEqual(payload.partial.ok, false);
  assert.strictEqual(payload.partial.atomic, false);
  assert.deepStrictEqual(payload.partial.completed, []);
  assert.strictEqual(payload.partial.failedStep, 'transition');
  assert.strictEqual(payload.partial.failedStepApplied, 'no');
  // 善後說明與參照指引並存，後者不得蓋掉前者。
  assert.match(result.content[0].text, /步驟「transition」失敗/);
  assert.match(result.content[0].text, /沿用同一把 idempotencyKey/);
  assert.match(result.content[0].text, /litejira\.searchTickets/);
});

test('GH-360：replyFeedback 的非 not_found 錯誤不被參照指引污染', async () => {
  const fetchImpl = errFetch(409, {
    code: 'idempotency_key_reused', message: '鍵重複', details: { reason: 'in_progress' }
  });
  const result = await callTool('litejira.replyFeedback', {
    ticketId: 'REQ-2229', content: '收到', idempotencyKey: 'gh360-reply-key-0002'
  }, cfg({ enableWrites: true }), fetchImpl);

  assert.ok(result.isError);
  assert.strictEqual(result.structuredContent.error.hint, undefined, '其他錯誤不得被加料');
  assert.doesNotMatch(result.content[0].text, /前綴/);
  assert.strictEqual(result.structuredContent.partial.idempotencyReuse, 'in_progress');
  assert.strictEqual(result.structuredContent.partial.failedStepApplied, 'unknown');
});

// ── T1：resource 與工具同語意 ──

test('GH-360：resource 與工具入口打同一條路徑，not_found 也拿到同一段指引', async () => {
  const resFetch = errFetch(404, { code: 'not_found', message: '找不到' });
  const response = await rpc('resources/read', { uri: 'litejira://ticket/REQ-2229' }, cfg(), resFetch);
  assert.strictEqual(resFetch.calls.length, 1, 'resource 也不得自動 fallback');
  assert.strictEqual(resFetch.calls[0].url, V1 + '/tickets/REQ-2229');
  assert.strictEqual(response.error.data.code, 'not_found');
  assert.ok(response.error.message.startsWith('找不到'), response.error.message);

  const toolHint = await notFoundHintForTool('REQ-2229');
  assert.ok(response.error.message.indexOf(toolHint) !== -1,
    'resource 的訊息要含有與工具逐字相同的指引：' + response.error.message);
});

// ── T11：說明字面 ──

test('GH-360：tools/list 的工單參照說明都要求沿用伺服器回傳的字面值', async () => {
  const tools = listTools();
  const refTools = tools.filter(function (t) {
    const p = t.inputSchema.properties || {};
    return p.ticketId || p.childId || p.tickets;
  });
  assert.ok(refTools.length >= 10, '應該有一批工具收工單參照：' + refTools.length);
  for (const t of refTools) {
    const p = t.inputSchema.properties;
    const desc = [
      p.ticketId && p.ticketId.description,
      p.childId && p.childId.description,
      p.tickets && p.tickets.description
    ].filter(Boolean).join('\n');
    assert.match(desc, /key/, t.name);
    assert.ok(/不要用類型代碼自行拼|不要把類型代碼和編號自行拼|never assemble a key|never build one from the ticket type|never type\+number|不要用類型代碼自行拼出編號/.test(desc),
      t.name + ' 的工單參照說明沒講「不可自行拼前綴」：' + desc);
  }
});

test('GH-360：resource 模板與 prompt 的說明同步，weekly-status 不再叫人改用前綴 key', async () => {
  const templates = (await rpc('resources/templates/list', {}, cfg(), null)).result.resourceTemplates;
  const ticket = templates.find(function (t) { return t.uriTemplate === 'litejira://ticket/{id}'; });
  assert.match(ticket.description, /REQ-2229/);
  assert.match(ticket.description, /伺服器回傳的 key 字面值/);

  const prompts = (await rpc('prompts/list', {}, cfg(), null)).result.prompts;
  for (const p of prompts) {
    const arg = (p.arguments || []).find(function (a) { return a.name === 'ticketId'; });
    if (arg) assert.match(arg.description, /原字串/, p.name);
  }

  const weekly = await rpc('prompts/get', { name: 'weekly-status', arguments: {} }, cfg(), null);
  const weeklyText = weekly.result.messages.map(function (m) { return m.content.text; }).join('\n');
  assert.doesNotMatch(weeklyText, /公開 key（如 BUG-481）稱呼/);
  assert.match(weeklyText, /key 欄位的原字串/);

  const triage = await rpc('prompts/get', { name: 'triage-ticket', arguments: { ticketId: '2229' } }, cfg(), null);
  const triageText = triage.result.messages.map(function (m) { return m.content.text; }).join('\n');
  assert.match(triageText, /別用類型拼前綴/);

  const init = await handleJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.match(init.result.instructions, /別用類型拼前綴/);
});

// ── 真 stdio：同樣的事情在真的啟動路徑上再驗一次 ──

const SERVER = path.join(__dirname, '..', 'litejira-mcp-server.js');
const STDIO_TOKEN = 'ltj_pat_smoke_not_a_real_token';

// stub 只認得兩個身分：純數字 key `2229` 與它的 UUID。其餘一律 404 not_found
// （不存在、無權限、已刪除在後端本來就不可分辨，stub 照這個語意走）。
function startStub() {
  const requests = [];
  const server = http.createServer(function (req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, pathname: url.pathname });
    const m = url.pathname.match(/^\/api\/v1\/tickets\/([^/]+)$/);
    if (m && (m[1] === '2229' || m[1] === UUID)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { id: UUID, key: '2229', type: 'REQ', title: 'stub' } }));
      return;
    }
    if (/^\/api\/v1\/tickets\/([^/]+)\/transitions$/.test(url.pathname)) {
      const ref = url.pathname.split('/')[4];
      if (ref === '2229' || ref === UUID) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { actions: [], transitions: [] } }));
        return;
      }
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }));
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      resolve({ server: server, requests: requests, port: server.address().port });
    });
  });
}

function startClient(baseUrl) {
  const child = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, {
      LTJ_API_URL: baseUrl,
      LTJ_API_TOKEN: STDIO_TOKEN,
      LTJ_PROJECT: 'SMOKE',
      LTJ_MCP_ENABLE_WRITES: 'false'
    }),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map();
  const stderr = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', function (chunk) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === '') continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', function (chunk) { stderr.push(chunk); });

  let nextId = 0;
  return {
    call: function (method, params) {
      const id = ++nextId;
      return new Promise(function (resolve, reject) {
        const timer = setTimeout(function () {
          pending.delete(id);
          reject(new Error('stdio 逾時：' + method + '（stderr: ' + stderr.join('') + '）'));
        }, 10000);
        pending.set(id, function (message) { clearTimeout(timer); resolve(message); });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }) + '\n');
      });
    },
    stop: function () { child.kill(); }
  };
}

test('GH-360 stdio：真協定上，合成前綴安全落地、真實參照直通、全程不自動 fallback', async function (t) {
  const stub = await startStub();
  const client = startClient('http://127.0.0.1:' + stub.port);
  t.after(function () { client.stop(); stub.server.close(); });

  await client.call('initialize', { protocolVersion: '2024-11-05' });

  // 1) 真實 key 與 UUID 兩路都命中同一張單。
  for (const ref of ['2229', UUID]) {
    const before = stub.requests.length;
    const read = await client.call('resources/read', { uri: 'litejira://ticket/' + ref });
    assert.strictEqual(read.error, undefined, ref + ' 應該讀得到');
    const body = JSON.parse(read.result.contents[0].text);
    assert.strictEqual(body.id, UUID, ref + ' 必須指到同一張單');
    assert.strictEqual(body.key, '2229');
    assert.strictEqual(stub.requests.length, before + 1, ref + ' 應該剛好一發');

    const tool = await client.call('tools/call', {
      name: 'litejira.getTransitions', arguments: { ticketId: ref }
    });
    assert.ok(!tool.result.isError, ref + ' 的讀取工具不該出錯');
  }

  // 2) 合成前綴：兩個入口都安全落地在 not_found，且各只打一發（沒有剝前綴重試）。
  const beforeSynth = stub.requests.length;
  const resErr = await client.call('resources/read', { uri: 'litejira://ticket/REQ-2229' });
  assert.ok(resErr.error, 'resource 應回 JSON-RPC error');
  assert.strictEqual(resErr.error.data.code, 'not_found');
  assert.match(resErr.error.message, /litejira\.searchTickets/);
  assert.match(resErr.error.message, /REQ-2229/);
  assert.doesNotMatch(resErr.error.message, /確定不存在|一定不存在/);

  const toolErr = await client.call('tools/call', {
    name: 'litejira.getTransitions', arguments: { ticketId: 'REQ-2229' }
  });
  assert.ok(toolErr.result.isError, '工具應回 isError');
  assert.match(toolErr.result.content[0].text, /litejira\.searchTickets/);

  const synthRequests = stub.requests.slice(beforeSynth);
  assert.strictEqual(synthRequests.length, 2, '兩個入口各一發，不得有第三發：' +
    JSON.stringify(synthRequests));
  assert.deepStrictEqual(synthRequests.map(function (r) { return r.pathname; }), [
    '/api/v1/tickets/REQ-2229',
    '/api/v1/tickets/REQ-2229/transitions'
  ]);

  // 3) 全程唯讀。
  assert.deepStrictEqual(stub.requests.filter(function (r) { return r.method !== 'GET'; }), []);
});

test('GH-360：其他 API 錯誤的 structuredContent 與 resource message 保留原契約', async () => {
  const error = { code: 'permission_denied', message: 'forbidden', details: { reason: 'role' } };
  const toolFetch = errFetch(403, error);
  const tool = await callTool('litejira.getTransitions', { ticketId: 'REQ-2229' }, cfg(), toolFetch);
  assert.deepStrictEqual(tool.structuredContent.error, Object.assign({ status: 403 }, error));
  assert.strictEqual(toolFetch.calls.length, 1);
  const resFetch = errFetch(403, error);
  const response = await rpc('resources/read', { uri: 'litejira://ticket/REQ-2229' }, cfg(), resFetch);
  assert.strictEqual(response.error.message, error.message);
  assert.strictEqual(response.error.data.code, error.code);
  assert.deepStrictEqual(response.error.data.details, error.details);
  assert.strictEqual(resFetch.calls.length, 1);
});
