'use strict';

// LiteJira GH-436：送測三欄改成「發布方式＋預期結果＋驗證&重現方式」，修復方式改選填，
// 網頁上的欄位名也改成「預期結果／驗證&重現方式／調整&修復方式（選填）」。
// createTicket 的欄位說明與 report-bug 引導要跟著改，否則助手會把重現步驟填進送測不看的 reproSteps。

const test = require('node:test');
const assert = require('node:assert');

const { handleJsonRpcRequest, listTools } = require('../litejira-mcp-server');

function createProps() {
  return listTools().find(function (t) { return t.name === 'litejira.createTicket'; }).inputSchema.properties;
}

test('GH-436：createTicket 四個長文欄位的說明對齊新欄位名', function () {
  const p = createProps();
  assert.match(p.expectedResult.description, /預期結果 —— BUG／REQ 送測必填/);
  assert.match(p.validationMethod.description, /驗證&重現方式（舊名 verifyMethod）—— BUG／REQ 送測必填（LiteJira GH-436）；重現步驟也寫在這裡/);
  assert.match(p.fixMethod.description, /調整&修復方式（選填）/);
  assert.match(p.reproSteps.description, /舊欄位.*送測不看這欄；重現步驟請寫進 validationMethod/);
  // 反向：GH-436 以前的寫法不得改回來
  assert.doesNotMatch(p.expectedResult.description, /BUG 用/);
  assert.doesNotMatch(p.reproSteps.description, /BUG 用/);
  assert.doesNotMatch(p.reproSteps.description, /這是獨立欄位/);
});

test('GH-436：report-bug 引導問預期結果與驗證&重現方式，不叫助手用 reproSteps', async function () {
  const fetchImpl = function () { throw new Error('不應該送出任何請求'); };
  const config = { apiUrl: 'https://litejira.example.com', token: 'ltj_pat_test_abcdefgh', project: 'LTJ', enableWrites: true };
  const listed = await handleJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'prompts/list', params: {} }, config, fetchImpl);
  const meta = listed.result.prompts.find(function (p) { return p.name === 'report-bug'; });
  assert.match(meta.description, /預期結果\/驗證&重現方式/);
  const got = await handleJsonRpcRequest({
    jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'report-bug', arguments: { title: 'T' } }
  }, config, fetchImpl);
  const text = got.result.messages[0].content.text;
  assert.match(text, /然後問我：標題、預期結果、驗證&重現方式（含重現步驟）/);
  assert.match(text, /expectedResult \/ validationMethod 這兩個獨立欄位/);
  assert.match(text, /不要用舊欄位 reproSteps/);
  // 反向：舊引導「重現步驟放 reproSteps」不得改回來
  assert.doesNotMatch(text, /重現步驟與預期結果請放在 reproSteps/);
});
