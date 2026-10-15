'use strict';
// GH-392：待決事項與目前摘要的 8 支工具。驗 MCP 這一層：打到哪個 v1 端點、帶什麼內文與冪等鍵、
// 哪些輸入在送出前就擋下。權限、狀態機與樂觀並行由後端 v2/server 的測試把守。
const test = require('node:test');
const assert = require('node:assert/strict');
const { callTool, handleJsonRpcRequest, listTools } = require('../litejira-mcp-server');
const cfg = { apiUrl: 'https://litejira.example.com', token: 'test-token', enableWrites: true };
const KEY = 'gh392_decisions_test_001';
const DECISION = '11111111-2222-4333-8444-555555555555';
const MEMBER = '22222222-3333-4444-8555-666666666666';
const AT = '2026-10-15T01:00:00.123456Z';

function recorder(data, status = 200) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, ...init }); return { status, text: async () => JSON.stringify(data) }; };
  return { calls, fetch };
}
const headerOf = (call, name) => {
  const h = call.headers || {};
  const found = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return found === undefined ? undefined : h[found];
};

test('8 支工具都公告；寫入的都要求 idempotencyKey、讀取的不要求', () => {
  const tools = listTools();
  const reads = ['listDecisions', 'listDecisionsAskedToMe', 'getSummary'];
  const writes = ['openDecisions', 'answerDecision', 'withdrawDecision', 'updateDecision', 'setSummary'];
  for (const name of [...reads, ...writes]) {
    const t = tools.find((x) => x.name === 'litejira.' + name);
    assert.ok(t, name + ' 應該出現在 tools/list');
    assert.equal(t.inputSchema.required.includes('idempotencyKey'), writes.includes(name), name);
  }
  // 開題工具要講明「不要寫在留言裡」——這句話是改變 AI 行為的主要手段
  assert.match(tools.find((t) => t.name === 'litejira.openDecisions').description, /INSTEAD of listing questions in a comment/);
});

test('instructions 帶開題與先讀摘要那一句，預算仍在 1000 內', async () => {
  const res = await handleJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.match(res.result.instructions, /openDecisions/);
  assert.match(res.result.instructions, /getSummary/);
  assert.ok(res.result.instructions.length <= 1000);
});

test('讀取：清單帶 status、跨專案問我的帶 limit、摘要帶 history', async () => {
  const r = recorder({ data: { items: [] } });
  await callTool('litejira.listDecisions', { ticketId: 'REQ-2330', status: 'open' }, cfg, r.fetch);
  await callTool('litejira.listDecisionsAskedToMe', { limit: 20 }, cfg, r.fetch);
  await callTool('litejira.getSummary', { ticketId: 'REQ-2330', history: true }, cfg, r.fetch);
  assert.deepEqual(r.calls.map((c) => c.method + ' ' + c.url), [
    'GET ' + cfg.apiUrl + '/api/v1/tickets/REQ-2330/decisions?status=open',
    'GET ' + cfg.apiUrl + '/api/v1/decisions/asked-to-me?limit=20',
    'GET ' + cfg.apiUrl + '/api/v1/tickets/REQ-2330/summary?history=true',
  ]);
  for (const c of r.calls) assert.equal(headerOf(c, 'Idempotency-Key'), undefined);
});

test('開題：POST 內文原樣帶 decisions 與 sourceCommentId，冪等鍵在 header', async () => {
  const r = recorder({ data: { items: [] } }, 201);
  const decisions = [{ question: '首儲失敗要不要顯示退款提示？', askedToId: MEMBER, options: ['顯示', '不顯示'], dueOn: '2026-10-17' }];
  await callTool('litejira.openDecisions', { ticketId: 'REQ-2330', decisions, sourceCommentId: DECISION, idempotencyKey: KEY }, cfg, r.fetch);
  const [c] = r.calls;
  assert.equal(c.method, 'POST');
  assert.equal(c.url, cfg.apiUrl + '/api/v1/tickets/REQ-2330/decisions');
  assert.deepEqual(JSON.parse(c.body), { decisions, sourceCommentId: DECISION });
  assert.equal(headerOf(c, 'Idempotency-Key'), KEY);
});

test('回答、撤回、編輯、覆寫摘要打到各自的路徑與方法', async () => {
  const r = recorder({ data: {} });
  await callTool('litejira.answerDecision', { ticketId: 'REQ-2330', decisionId: DECISION, option: 0, expectedUpdatedAt: AT, idempotencyKey: KEY }, cfg, r.fetch);
  await callTool('litejira.withdrawDecision', { ticketId: 'REQ-2330', decisionId: DECISION, reason: '會議已定案', expectedUpdatedAt: AT, idempotencyKey: KEY + '_w' }, cfg, r.fetch);
  await callTool('litejira.updateDecision', { ticketId: 'REQ-2330', decisionId: DECISION, askedToId: MEMBER, expectedUpdatedAt: AT, idempotencyKey: KEY + '_u' }, cfg, r.fetch);
  await callTool('litejira.setSummary', { ticketId: 'REQ-2330', statusText: '等美術', blockedOnIds: [MEMBER], nextStep: '交表後重審', externalDeps: ['Alpha6 美術'], expectedVersion: 0, idempotencyKey: KEY + '_s' }, cfg, r.fetch);
  assert.deepEqual(r.calls.map((c) => c.method + ' ' + c.url.replace(cfg.apiUrl, '')), [
    'POST /api/v1/tickets/REQ-2330/decisions/' + DECISION + '/answer',
    'POST /api/v1/tickets/REQ-2330/decisions/' + DECISION + '/withdraw',
    'PATCH /api/v1/tickets/REQ-2330/decisions/' + DECISION,
    'PUT /api/v1/tickets/REQ-2330/summary',
  ]);
  assert.deepEqual(JSON.parse(r.calls[0].body), { option: 0, expectedUpdatedAt: AT });
  assert.deepEqual(JSON.parse(r.calls[3].body), { statusText: '等美術', blockedOnIds: [MEMBER], nextStep: '交表後重審', externalDeps: ['Alpha6 美術'], expectedVersion: 0 });
});

test('送出前就擋：題目 id 不是 UUID、expectedUpdatedAt 轉成毫秒、卡在誰用顯示名', async () => {
  const r = recorder({ data: {} });
  const bad = [
    ['litejira.answerDecision', { ticketId: 'REQ-1', decisionId: 'D3', option: 0, expectedUpdatedAt: AT, idempotencyKey: KEY }],
    ['litejira.answerDecision', { ticketId: 'REQ-1', decisionId: DECISION, option: 0, expectedUpdatedAt: 1792040000000, idempotencyKey: KEY }],
    ['litejira.setSummary', { ticketId: 'REQ-1', statusText: '', blockedOnIds: ['企劃'], blockedNote: '', nextStep: '', externalDeps: [], expectedVersion: 0, idempotencyKey: KEY }],
  ];
  for (const [name, args] of bad) {
    const result = await callTool(name, args, cfg, r.fetch).catch((err) => ({ isError: true, err }));
    assert.ok(result.isError, name + ' 應該在本機就被擋下');
  }
  assert.equal(r.calls.length, 0, '一發都不該送出');
});

test('searchTickets 的 mine 認得 decision（等待處理），跨專案', async () => {
  const r = recorder({ data: { items: [], nextCursor: null } });
  await callTool('litejira.searchTickets', { mine: 'decision' }, { ...cfg, project: '' }, r.fetch);
  assert.match(r.calls[0].url, /mine=decision/);
});
