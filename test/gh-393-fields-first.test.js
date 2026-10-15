const assert = require('node:assert/strict');
const test = require('node:test');
const { listTools } = require('../litejira-mcp-server');

// LiteJira GH-393：正式站抽樣中，MR 連結、驗證方式、可驗版本、工單依賴都被寫進留言而不是欄位。
// 寫留言的兩支與改欄位那一支要在說明裡把 AI 指回正確的工具。只改說明文字，參數不變。
const byName = (name) => listTools().find((tool) => tool.name === name);

test('GH-393：addComment 與 replyFeedback 說明指回欄位與關聯工具', () => {
  for (const name of ['litejira.addComment', 'litejira.replyFeedback']) {
    const desc = byName(name).description;
    assert.match(desc, /FIELDS FIRST/, name);
    assert.match(desc, /litejira\.addTicketLink \(kind=mr\)/, name + '：MR 連結');
    assert.match(desc, /litejira\.updateField/, name + '：驗證方式與可驗版本');
    assert.match(desc, /litejira\.addTicketRelation/, name + '：工單依賴');
  }
});

test('GH-393：updateField 說明要求有欄位就填欄位，依賴走關聯工具', () => {
  const desc = byName('litejira.updateField').description;
  assert.match(desc, /FIELDS FIRST/);
  assert.match(desc, /validationMethod/);
  assert.match(desc, /verifiableVersionAlpha/);
  assert.match(desc, /litejira\.addTicketRelation/);
});
