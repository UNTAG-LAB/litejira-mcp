'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { callTool, handleJsonRpcRequest, listTools } = require('../litejira-mcp-server');
const { buildRequest } = require('../litejira-v1-transport');
const cfg = { apiUrl: 'https://litejira.example.com', token: 'test-token', enableWrites: true };
const linkId = '11111111-2222-4333-8444-555555555555';
const key = 'ticket_links_test_001';
const item = { id: linkId, url: 'https://git.example.com/mr/1', label: 'MR', kind: 'mr', createdAt: null, createdBy: null };
function recorder(data, status = 200) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, ...init }); return { status, text: async () => JSON.stringify(data) }; };
  return { calls, fetch };
}
test('links discovery distinguishes UI links, legacy mrUrl and attachments', () => {
  for (const name of ['listTicketLinks', 'addTicketLink', 'removeTicketLink']) {
    assert.ok(listTools().some(t => t.name === 'litejira.' + name));
  }
  assert.match(listTools().find(t => t.name === 'litejira.attachLink').description, /addTicketLink/);
});
test('list tool and URI return the same complete typed link collection', async () => {
  const r = recorder({ data: { items: [item] } });
  const result = await callTool('litejira.listTicketLinks', { ticketId: 'REQ-1803' }, cfg, r.fetch);
  assert.deepEqual(result.structuredContent, { items: [item] });
  const rpc = await handleJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'litejira://ticket/REQ-1803/links' } }, cfg, r.fetch);
  assert.deepEqual(JSON.parse(rpc.result.contents[0].text), { items: [item] });
  assert.equal(r.calls.length, 2);
  for (const c of r.calls) { assert.equal(c.url, cfg.apiUrl + '/api/v1/tickets/REQ-1803/links'); assert.equal(c.method, 'GET'); }
});
test('add sends exact UI link body and idempotency header; label may be empty', async () => {
  const r = recorder({ data: item }, 201);
  const result = await callTool('litejira.addTicketLink', { ticketId: 'REQ-1803', url: item.url, label: '', kind: 'mr', idempotencyKey: key }, cfg, r.fetch);
  assert.deepEqual(result.structuredContent, item);
  assert.deepEqual(JSON.parse(r.calls[0].body), { url: item.url, label: '', kind: 'mr' });
  assert.equal(r.calls[0].headers['Idempotency-Key'], key);
  assert.equal(r.calls[0].method, 'POST');
});
test('remove uses link UUID and consumes HTTP 200 remaining collection', async () => {
  const r = recorder({ data: { items: [] } });
  const result = await callTool('litejira.removeTicketLink', { ticketId: 'REQ-1803', linkId, idempotencyKey: key }, cfg, r.fetch);
  assert.deepEqual(result.structuredContent, { items: [] });
  assert.equal(r.calls[0].method, 'DELETE');
  assert.equal(r.calls[0].url, cfg.apiUrl + '/api/v1/tickets/REQ-1803/links/' + linkId);
  assert.equal(r.calls[0].body, undefined);
});
test('write-disabled, missing key, wrong kind, wrong UUID and pagination never send a request', async () => {
  const r = recorder({ data: {} });
  for (const [tool, args, config] of [
    ['addTicketLink', { ticketId: 'REQ-1803', url: item.url, idempotencyKey: key }, { ...cfg, enableWrites: false }],
    ['addTicketLink', { ticketId: 'REQ-1803', url: item.url }, cfg],
    ['addTicketLink', { ticketId: 'REQ-1803', url: item.url, kind: 'pr', idempotencyKey: key }, cfg],
    ['removeTicketLink', { ticketId: 'REQ-1803', linkId: item.url, idempotencyKey: key }, cfg],
    ['listTicketLinks', { ticketId: 'REQ-1803', limit: 10 }, cfg]
  ]) await assert.rejects(callTool('litejira.' + tool, args, config, r.fetch));
  assert.equal(r.calls.length, 0);
  assert.throws(() => buildRequest({ baseUrl: cfg.apiUrl, token: cfg.token, action: 'addTicketLink', params: { ticketId: 'REQ-1803', url: item.url } }), /Idempotency-Key/);
});
test('API denials preserve permission/not-found/URL validation codes', async () => {
  for (const [status, code] of [[403, 'permission_denied'], [404, 'not_found'], [422, 'invalid_argument']]) {
    const r = recorder({ error: { code, message: 'Rejected' } }, status);
    const result = await callTool('litejira.addTicketLink', { ticketId: 'REQ-1803', url: item.url, idempotencyKey: key }, cfg, r.fetch);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, code);
    assert.equal(r.calls.length, 1);
  }
});
test('uncertain writes are not retried and instruct readback with same key', async () => {
  for (const type of ['network', 'invalid', '500']) {
    let calls = 0;
    const fetch = async () => { calls++; if (type === 'network') throw new Error('secret'); return { status: type === '500' ? 500 : 200, text: async () => type === '500' ? JSON.stringify({ error: { code: 'internal', message: 'failure' } }) : '<html>' }; };
    await assert.rejects(callTool('litejira.addTicketLink', { ticketId: 'REQ-1803', url: item.url, idempotencyKey: key }, cfg, fetch), err => {
      assert.match(err.message, /listTicketLinks/);
      assert.match(err.message, /idempotencyKey/);
      assert.doesNotMatch(err.message, /secret/);
      return true;
    });
    assert.equal(calls, 1);
  }
});
