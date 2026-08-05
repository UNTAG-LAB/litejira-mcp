const assert = require('node:assert/strict');
const test = require('node:test');
const {
  callTool,
  handleJsonRpcRequest,
  listTools
} = require('../litejira-mcp-server');

const config = {
  apiUrl: 'https://example.test/exec',
  token: 'ltj_pat_test',
  enableWrites: false
};

test('GH-265：searchTickets schema 公開三種回傳模式', () => {
  const search = listTools().find((tool) => tool.name === 'litejira.searchTickets');
  const schema = search.inputSchema.properties.responseMode;

  assert.deepEqual(schema.enum, ['count', 'compact', 'full']);
  assert.equal(schema.default, 'compact');
  assert.match(search.description, /compact/i);
});

test('GH-265：MCP 未指定時補 compact，明確 full 不覆寫', async () => {
  const sentParams = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    sentParams.push(body.params);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, data: { items: [] } })
    };
  };

  await callTool('litejira.searchTickets', { limit: 5 }, config, fetchImpl);
  await callTool('litejira.searchTickets', { limit: 5, responseMode: 'full' }, config, fetchImpl);

  assert.equal(sentParams[0].responseMode, 'compact');
  assert.equal(sentParams[1].responseMode, 'full');
});

test('GH-265：instructions 瘦身後仍保留安全規則', async () => {
  const response = await handleJsonRpcRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {}
  });
  const instructions = response.result.instructions;

  assert.ok(instructions.length <= 1000);
  ['idempotencyKey', 'litejira://meta', 'getTransitions', 'transitionTicket', 'P0-緊急'].forEach((word) => {
    assert.ok(instructions.includes(word), `instructions 缺少 ${word}`);
  });
});
