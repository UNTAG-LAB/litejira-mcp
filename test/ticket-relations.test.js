'use strict';
// GH-372：工單關聯三支工具（網站「加關聯」：被擋住／擋住等）。
// 驗的是 MCP 這一層：打到哪個 v1 端點、帶什麼內文與冪等鍵、哪些輸入在送出前就擋下、
// 寫入結果未知時怎麼指引。成對寫入、權限與冪等回放由後端 v2/server 的測試把守。
const test = require('node:test');
const assert = require('node:assert/strict');
const { callTool, handleJsonRpcRequest, listTools } = require('../litejira-mcp-server');
const { buildRequest } = require('../litejira-v1-transport');
const cfg = { apiUrl: 'https://litejira.example.com', token: 'test-token', enableWrites: true };
const key = 'ticket_relations_test_001';
const item = {
  kind: 'blocked_by', direction: 'outgoing',
  ticket: { id: '11111111-2222-4333-8444-555555555555', key: 'REQ-2333', type: 'REQ', title: '前置', status: '開發中', stateGroup: 'started', isFinal: false },
  createdAt: null, createdBy: null
};
function recorder(data, status = 200) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, ...init }); return { status, text: async () => JSON.stringify(data) }; };
  return { calls, fetch };
}

test('三支工具都公告，說明分得出關聯、外部連結與父子', () => {
  const tools = listTools();
  for (const name of ['listTicketRelations', 'addTicketRelation', 'removeTicketRelation']) {
    assert.ok(tools.some(t => t.name === 'litejira.' + name), name + ' 應該出現在 tools/list');
  }
  const list = tools.find(t => t.name === 'litejira.listTicketRelations');
  assert.match(list.description, /listTicketLinks/);
  assert.match(list.description, /linkTickets/);
  // 新增工具要講清楚讀法（「ticketId <kind> targetId」），blocked_by 是最常用的那一種
  assert.match(tools.find(t => t.name === 'litejira.addTicketRelation').description, /blocked_by/);
});

test('kind 列舉是十種、兩支寫入工具共用同一份', () => {
  const tools = listTools();
  const add = tools.find(t => t.name === 'litejira.addTicketRelation').inputSchema.properties.kind.enum;
  const remove = tools.find(t => t.name === 'litejira.removeTicketRelation').inputSchema.properties.kind.enum;
  assert.equal(add.length, 10);
  assert.deepEqual(add, remove);
  assert.ok(add.includes('blocked_by') && add.includes('blocks'));
});

test('清單工具與 litejira://ticket/{id}/relations 讀到同一份、打同一個端點', async () => {
  const r = recorder({ data: { items: [item] } });
  const result = await callTool('litejira.listTicketRelations', { ticketId: 'BUG-2368' }, cfg, r.fetch);
  assert.deepEqual(result.structuredContent, { items: [item] });
  const rpc = await handleJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'litejira://ticket/BUG-2368/relations' } }, cfg, r.fetch);
  assert.deepEqual(JSON.parse(rpc.result.contents[0].text), { items: [item] });
  assert.equal(r.calls.length, 2);
  for (const c of r.calls) {
    assert.equal(c.url, cfg.apiUrl + '/api/v1/tickets/BUG-2368/relations');
    assert.equal(c.method, 'GET');
  }
});

test('工單詳情資源的說明指向關聯資源', async () => {
  const rpc = await handleJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'resources/templates/list', params: {} }, cfg, async () => { throw new Error('不該打網路'); });
  const detail = rpc.result.resourceTemplates.find(r => r.uriTemplate === 'litejira://ticket/{id}');
  assert.match(detail.description, /litejira:\/\/ticket\/\{id\}\/relations/);
});

test('新增只送 {kind,targetId}，冪等鍵放 header', async () => {
  const r = recorder({ data: item }, 201);
  const result = await callTool('litejira.addTicketRelation', { ticketId: 'BUG-2368', kind: 'blocked_by', targetId: 'REQ-2333', idempotencyKey: key }, cfg, r.fetch);
  assert.deepEqual(result.structuredContent, item);
  assert.equal(r.calls[0].method, 'POST');
  assert.equal(r.calls[0].url, cfg.apiUrl + '/api/v1/tickets/BUG-2368/relations');
  assert.deepEqual(JSON.parse(r.calls[0].body), { kind: 'blocked_by', targetId: 'REQ-2333' });
  assert.equal(r.calls[0].headers['Idempotency-Key'], key);
});

test('移除以（本單、語意、對象單）三段路徑定位，不帶內文、回剩下的整份清單', async () => {
  const r = recorder({ data: { items: [] } });
  const result = await callTool('litejira.removeTicketRelation', { ticketId: 'BUG-2368', kind: 'blocked_by', targetId: 'REQ-2333', idempotencyKey: key }, cfg, r.fetch);
  assert.deepEqual(result.structuredContent, { items: [] });
  assert.equal(r.calls[0].method, 'DELETE');
  assert.equal(r.calls[0].url, cfg.apiUrl + '/api/v1/tickets/BUG-2368/relations/blocked_by/REQ-2333');
  assert.equal(r.calls[0].body, undefined);
  assert.equal(r.calls[0].headers['Idempotency-Key'], key);
});

test('關閉寫入、缺冪等鍵、不認得的語意、缺對象單、多餘參數都不送出請求', async () => {
  const r = recorder({ data: {} });
  for (const [tool, args, config] of [
    ['addTicketRelation', { ticketId: 'BUG-2368', kind: 'blocked_by', targetId: 'REQ-2333', idempotencyKey: key }, { ...cfg, enableWrites: false }],
    ['addTicketRelation', { ticketId: 'BUG-2368', kind: 'blocked_by', targetId: 'REQ-2333' }, cfg],
    ['addTicketRelation', { ticketId: 'BUG-2368', kind: 'blocker', targetId: 'REQ-2333', idempotencyKey: key }, cfg],
    ['addTicketRelation', { ticketId: 'BUG-2368', kind: 'blocks', idempotencyKey: key }, cfg],
    ['removeTicketRelation', { ticketId: 'BUG-2368', kind: 'blocks', targetId: '../../tokens', idempotencyKey: key }, cfg],
    ['removeTicketRelation', { ticketId: 'BUG-2368', kind: 'blocks', idempotencyKey: key }, cfg],
    ['listTicketRelations', { ticketId: 'BUG-2368', limit: 10 }, cfg]
  ]) await assert.rejects(callTool('litejira.' + tool, args, config, r.fetch), tool + ' ' + JSON.stringify(args));
  assert.equal(r.calls.length, 0);
  assert.throws(() => buildRequest({ baseUrl: cfg.apiUrl, token: cfg.token, action: 'addTicketRelation', params: { ticketId: 'BUG-2368', kind: 'blocks', targetId: 'REQ-1' } }), /Idempotency-Key/);
});

test('後端拒絕原樣轉出（權限、查無、重複建立、參數）', async () => {
  for (const [status, code] of [[403, 'permission_denied'], [404, 'not_found'], [409, 'state_conflict'], [422, 'invalid_argument']]) {
    const r = recorder({ error: { code, message: 'Rejected' } }, status);
    const result = await callTool('litejira.addTicketRelation', { ticketId: 'BUG-2368', kind: 'blocks', targetId: 'REQ-1', idempotencyKey: key }, cfg, r.fetch);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, code);
    assert.equal(r.calls.length, 1);
  }
});

test('寫入結果未知時不自動重送，指示先回讀再用原 key 重送', async () => {
  for (const tool of ['addTicketRelation', 'removeTicketRelation']) {
    for (const type of ['network', 'invalid', '500']) {
      let calls = 0;
      const fetch = async () => {
        calls++;
        if (type === 'network') throw new Error('secret');
        return { status: type === '500' ? 500 : 200, text: async () => type === '500' ? JSON.stringify({ error: { code: 'internal', message: 'failure' } }) : '<html>' };
      };
      await assert.rejects(callTool('litejira.' + tool, { ticketId: 'BUG-2368', kind: 'blocks', targetId: 'REQ-1', idempotencyKey: key }, cfg, fetch), err => {
        assert.match(err.message, /listTicketRelations/);
        assert.match(err.message, /idempotencyKey/);
        assert.doesNotMatch(err.message, /secret/);
        return true;
      });
      assert.equal(calls, 1, tool + ' ' + type + ' 不該自動重送');
    }
  }
});
