'use strict';

// LiteJira GH-436、GH-575：transitionTicket／batchTransition 的 fields 說明要跟後端現況一致。
//   GH-436：送測三欄是「發布方式＋預期結果＋驗證&重現方式」，修復方式改選填。
//   GH-575：檢查時機改成「進待合併至 alpha／待更新至 release／熱修待合 release」，送alpha測試／送release測試不再擋。
// 只驗說明字面：實際必填由伺服器決定，MCP 不重抄一份判定。

const test = require('node:test');
const assert = require('node:assert');

const { listTools } = require('../litejira-mcp-server');

function fieldsDescription(name) {
  const tool = listTools().find(function (t) { return t.name === name; });
  assert.ok(tool, name + ' 要存在');
  return tool.inputSchema.properties.fields.description;
}

['litejira.transitionTicket', 'litejira.batchTransition'].forEach(function (name) {
  test('GH-575：' + name + ' 的 fields 說明是新的檢查時機與三欄', function () {
    const text = fieldsDescription(name);
    assert.match(text, /「待合併至 alpha」「待更新至 release」「熱修待合 release」/);
    assert.match(text, /releaseMethod（發布方式，不可為「待定」）、expectedResult（預期結果）、validationMethod（驗證&重現方式）/);
    assert.match(text, /fixMethod（修復方式）是選填/);
    assert.match(text, /「送alpha測試」「送release測試」不再因這三欄被擋/);
    // 反向：GH-436 以前的三欄寫法、「送測類動作」的舊時機都不得改回來
    assert.doesNotMatch(text, /修復方式 \/ 驗證方式 \/ 發布方式/);
    assert.doesNotMatch(text, /送測類動作需要/);
  });
});
