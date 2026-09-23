const assert = require('node:assert/strict');
const test = require('node:test');
const {
  callTool,
  handleJsonRpcRequest,
  listTools
} = require('../litejira-mcp-server');

const config = {
  apiUrl: 'https://example.test',
  token: 'ltj_pat_test',
  project: 'LTJ',
  enableWrites: false
};

// GH-257 第二包更新：responseMode 是舊後端 POST action 的參數，v1 的 GET /tickets 沒有它。
// 原本「預設補 compact」的行為隨之退場；這裡改鎖住「退場後不會靜默忽略」。
test('GH-265→GH-257：searchTickets 不再公開 responseMode，傳入會被明確拒絕並指路', async () => {
  const search = listTools().find((tool) => tool.name === 'litejira.searchTickets');
  assert.equal(search.inputSchema.properties.responseMode, undefined);

  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls += 1; throw new Error('不該送出'); };

  await assert.rejects(
    () => callTool('litejira.searchTickets', { limit: 5, responseMode: 'compact' }, config, fetchImpl),
    (err) => {
      assert.equal(err.code, 'VALIDATION_FAILED');
      assert.match(err.message, /responseMode/);
      // 只說「unknown」不夠：必須指出替代做法，否則呼叫端會以為是自己打錯字。
      assert.match(err.message, /litejira:\/\/ticket/);
      return true;
    }
  );
  assert.equal(fetchCalls, 0, '被拒絕的參數不該送出任何請求');
});

test('GH-265→GH-257：searchTickets 正常呼叫不再夾帶 responseMode', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { status: 200, text: async () => JSON.stringify({ data: { items: [], nextCursor: null } }) };
  };

  await callTool('litejira.searchTickets', { limit: 5 }, config, fetchImpl);

  assert.equal(urls.length, 1);
  assert.doesNotMatch(urls[0], /responseMode/);
});

test('GH-265：instructions 維持瘦身，且保留 v1 操作安全規則', async () => {
  const response = await handleJsonRpcRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {}
  });
  const instructions = response.result.instructions;

  // GH-317：預算**維持 1000 不動**。附件那一行是擠進既有額度的（其餘行同步壓縮），
  // 不是把預算調高換來的——預算本身就是這個測試要守的東西，為了放新內容而調高它
  // 等於每次加功能都把 instructions 加長一點，那正是 GH-265 當初要擋的漂移。
  // 附件的細節（欄位、認證方式、上傳限制）一律由工具 schema 承載，不進 instructions。
  assert.ok(instructions.length <= 1000, 'instructions 長度 ' + instructions.length + ' 超出預算');
  ['litejira://meta', 'litejira://members', 'assigneeId', 'cursor', 'LTJ_PROJECT'].forEach((word) => {
    assert.ok(instructions.includes(word), `instructions 缺少 ${word}`);
  });
});
