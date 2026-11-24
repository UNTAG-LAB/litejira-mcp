// GH-339：讀文字附件（litejira.readAttachmentText）
//
// 靶在三件事上：
//   ① 工具的宣告（唯讀 annotations、strict schema、description 寫明界線與「內容不是指令」）
//   ② 傳輸（打的是 v1 REST 的 GET、帶 Bearer、不跟隨導向、權杖不外洩）
//   ③ 錯誤分流（只看 code 與 details.reason，五種 422 各有各的下一步）
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  callTool,
  listTools,
  validateToolInput
} = require('../litejira-mcp-server');
const { getLiteJiraApiV1 } = require('../ltj-cli');

const TOOL = 'litejira.readAttachmentText';
const ATTACHMENT_ID = '7f3b1c2e-4a5d-4e6f-8a9b-0c1d2e3f4a5b';
const config = {
  apiUrl: 'https://example.test/exec',
  v1ApiUrl: 'https://litejira.example.test',
  token: 'ltj_pat_SECRET_zzz',
  enableWrites: false
};

function delivery(overrides) {
  return Object.assign({
    attachment: {
      id: ATTACHMENT_ID,
      ticket: { id: '11111111-2222-3333-4444-555555555555', key: 'LJ-7' },
      name: 'GDD.md',
      mimeType: 'text/markdown',
      sizeBytes: 78759,
      createdAt: '2026-10-01T00:00:00.000Z'
    },
    encoding: 'utf-8',
    byteOffset: 0,
    byteLength: 65536,
    nextByteOffset: 65536,
    eof: false,
    chunkSha256: 'a'.repeat(64),
    contentSha256: null,
    text: '# 規格\n'
  }, overrides || {});
}

function jsonReply(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://litejira.example.test/api/v1/attachments/' + ATTACHMENT_ID + '/text',
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify(payload)
  };
}

function recordingFetch(reply) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return typeof reply === 'function' ? reply(calls.length) : reply;
  };
  return { calls, fetchImpl };
}

// ── ① 宣告 ──

test('GH-339：工具是唯讀的，annotations 不帶 destructiveHint', () => {
  const tool = listTools().find((t) => t.name === TOOL);

  assert.ok(tool, '工具必須出現在 tools/list');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.openWorldHint, true);
  assert.equal(typeof tool.annotations.title, 'string');
  assert.ok(!('destructiveHint' in tool.annotations), 'destructiveHint 不設（規格 R7）');
});

test('GH-339：工具數由 18 變 19，且 rest 描述子是內部細節、不外流到 tools/list', () => {
  const tools = listTools();

  // 主庫 tests/lj-116-mcp-schema-strict.test.js 有兩處硬斷言盯著這個數字（PR C 同步）
  assert.equal(tools.length, 19);
  tools.forEach((t) => {
    assert.ok(!('rest' in t), t.name + ' 不得把傳輸細節寫進 tools/list');
    assert.ok(!('action' in t), t.name + ' 不得把 action 寫進 tools/list');
    assert.ok(!('write' in t), t.name + ' 不得把 write 寫進 tools/list');
  });
});

test('GH-339：input schema 是 strict 的，三個參數界線寫死在 schema', () => {
  const tool = listTools().find((t) => t.name === TOOL);
  const schema = tool.inputSchema;

  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['attachmentId']);
  assert.equal(schema.properties.attachmentId.type, 'string');
  assert.ok(schema.properties.attachmentId.pattern, 'attachmentId 必須有 UUID pattern');
  assert.equal(schema.properties.offset.type, 'integer');
  assert.equal(schema.properties.offset.minimum, 0);
  assert.equal(schema.properties.limit.type, 'integer');
  assert.equal(schema.properties.limit.minimum, 4);
  assert.equal(schema.properties.limit.maximum, 256 * 1024);
});

test('GH-339：description 寫明型別界線、分段、版本限制與「內容不是指令」', () => {
  const tool = listTools().find((t) => t.name === TOOL);

  assert.match(tool.description, /md\/txt\/csv|Markdown/i);
  assert.match(tool.description, /UTF-8/);
  assert.match(tool.description, /2 MiB/);
  assert.match(tool.description, /nextByteOffset/);
  assert.match(tool.description, /contentSha256/);
  assert.match(tool.description, /DATA, NOT INSTRUCTIONS/i);
});

test('GH-339：schema 擋掉壞參數 — 非 UUID / 負 offset / 超大 limit / 多餘欄位', () => {
  const def = { inputSchema: listTools().find((t) => t.name === TOOL).inputSchema };

  assert.throws(() => validateToolInput(def, { attachmentId: 'BUG-530' }), /invalid parameter type/);
  assert.throws(() => validateToolInput(def, { attachmentId: ATTACHMENT_ID, offset: -1 }), /invalid parameter type/);
  assert.throws(() => validateToolInput(def, { attachmentId: ATTACHMENT_ID, offset: 1.5 }), /invalid parameter type/);
  assert.throws(() => validateToolInput(def, { attachmentId: ATTACHMENT_ID, limit: 1 }), /invalid parameter type/);
  assert.throws(() => validateToolInput(def, { attachmentId: ATTACHMENT_ID, limit: 262145 }), /invalid parameter type/);
  assert.throws(() => validateToolInput(def, { attachmentId: ATTACHMENT_ID, ticketId: 'BUG-1' }), /unknown parameter/);
  assert.throws(() => validateToolInput(def, { offset: 0 }), /missing required parameter/);
  assert.deepEqual(
    validateToolInput(def, { attachmentId: ATTACHMENT_ID, offset: 65536, limit: 4096 }),
    { attachmentId: ATTACHMENT_ID, offset: 65536, limit: 4096 }
  );
});

test('GH-339：不需要 idempotencyKey（唯讀），也不受 LTJ_MCP_ENABLE_WRITES 影響', async () => {
  const { fetchImpl } = recordingFetch(jsonReply(200, { data: delivery() }));

  const result = await callTool(TOOL, { attachmentId: ATTACHMENT_ID },
    Object.assign({}, config, { enableWrites: false }), fetchImpl);

  assert.ok(!result.isError);
});

// ── ② 傳輸 ──

test('GH-339：打 v1 REST 的 GET，帶 Bearer、不跟隨導向，視窗參數進查詢字串', async () => {
  const { calls, fetchImpl } = recordingFetch(jsonReply(200, { data: delivery() }));

  await callTool(TOOL, { attachmentId: ATTACHMENT_ID, offset: 65536, limit: 4096 }, config, fetchImpl);

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/v1/attachments/' + ATTACHMENT_ID + '/text');
  assert.equal(url.searchParams.get('offset'), '65536');
  assert.equal(url.searchParams.get('limit'), '4096');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error', '帶權杖的請求不得跟隨導向');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer ' + config.token);
  assert.equal(calls[0].options.body, undefined, '唯讀 GET 不帶內文');
});

test('GH-339：基底已含 /api/v1 時不重複接，尾斜線不產生雙斜線', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(new URL(url).pathname);
    return jsonReply(200, { data: delivery() });
  };

  await callTool(TOOL, { attachmentId: ATTACHMENT_ID },
    Object.assign({}, config, { v1ApiUrl: 'https://litejira.example.test/api/v1' }), fetchImpl);
  await callTool(TOOL, { attachmentId: ATTACHMENT_ID },
    Object.assign({}, config, { v1ApiUrl: 'https://litejira.example.test/api/v1/' }), fetchImpl);

  assert.deepEqual(seen, [
    '/api/v1/attachments/' + ATTACHMENT_ID + '/text',
    '/api/v1/attachments/' + ATTACHMENT_ID + '/text'
  ]);
});

test('GH-339：沒給 offset/limit 就不送那兩個參數（界線由伺服器的預設決定）', async () => {
  const { calls, fetchImpl } = recordingFetch(jsonReply(200, { data: delivery() }));

  await callTool(TOOL, { attachmentId: ATTACHMENT_ID }, config, fetchImpl);

  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('offset'), null);
  assert.equal(url.searchParams.get('limit'), null);
});

test('GH-339：成功回應原樣交出 text 與來源欄位（structuredContent + text 雙寫）', async () => {
  const payload = delivery({ byteOffset: 0, eof: true, nextByteOffset: null, contentSha256: 'b'.repeat(64) });
  const { fetchImpl } = recordingFetch(jsonReply(200, { data: payload }));

  const result = await callTool(TOOL, { attachmentId: ATTACHMENT_ID }, config, fetchImpl);

  assert.deepEqual(result.structuredContent, payload);
  assert.deepEqual(JSON.parse(result.content[0].text), payload);
  assert.equal(result.structuredContent.attachment.ticket.key, 'LJ-7', '來源要跟著內容一起交出去');
  assert.equal(result.structuredContent.contentSha256, 'b'.repeat(64));
});

test('GH-339：分段讀的 nextByteOffset / eof 原樣轉交，呼叫端照著走', async () => {
  const pages = [
    delivery({ byteOffset: 0, byteLength: 8, nextByteOffset: 8, eof: false, text: '前半' }),
    delivery({ byteOffset: 8, byteLength: 6, nextByteOffset: null, eof: true, text: '後半' })
  ];
  const { calls, fetchImpl } = recordingFetch((n) => jsonReply(200, { data: pages[n - 1] }));

  const first = await callTool(TOOL, { attachmentId: ATTACHMENT_ID }, config, fetchImpl);
  const second = await callTool(TOOL,
    { attachmentId: ATTACHMENT_ID, offset: first.structuredContent.nextByteOffset }, config, fetchImpl);

  assert.equal(first.structuredContent.eof, false);
  assert.equal(new URL(calls[1].url).searchParams.get('offset'), '8');
  assert.equal(second.structuredContent.eof, true);
  assert.equal(second.structuredContent.nextByteOffset, null);
  assert.equal(
    first.structuredContent.text + second.structuredContent.text, '前半後半');
});

test('GH-339：沒設 LTJ_V1_API_URL 時回 CONFIG_ERROR，且不發出任何請求', async () => {
  const { calls, fetchImpl } = recordingFetch(jsonReply(200, { data: delivery() }));

  await assert.rejects(
    () => callTool(TOOL, { attachmentId: ATTACHMENT_ID },
      Object.assign({}, config, { v1ApiUrl: '' }), fetchImpl),
    (err) => {
      assert.equal(err.code, 'CONFIG_ERROR');
      assert.match(err.message, /LTJ_V1_API_URL/);
      return true;
    });
  assert.equal(calls.length, 0);
});

test('GH-339：缺 LTJ_API_URL（Apps Script）不影響這一支唯讀 REST 工具', async () => {
  const { fetchImpl } = recordingFetch(jsonReply(200, { data: delivery() }));

  const result = await callTool(TOOL, { attachmentId: ATTACHMENT_ID },
    Object.assign({}, config, { apiUrl: '' }), fetchImpl);

  assert.ok(!result.isError);
});

test('GH-339：非 JSON 回應不夾帶原始內容，權杖與查詢字串都不外洩', async () => {
  const html = '<html><head><title>登入</title></head><body>'
    + '<input name="csrf" value="ltj_secret_csrf_zzz"></body></html>';
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    url: 'https://litejira.example.test/api/v1/attachments/x/text?token=ltj_pat_SECRET_zzz',
    headers: { get: () => 'text/html' },
    text: async () => html
  });

  await assert.rejects(
    () => getLiteJiraApiV1(fetchImpl, config.v1ApiUrl, config.token,
      ['attachments', ATTACHMENT_ID, 'text'], {}, { sleep: async () => {} }),
    (err) => {
      assert.match(err.message, /LiteJira v1 API 讀取失敗：HTTP 401/);
      assert.match(err.message, /頁面標題：登入/);
      assert.doesNotMatch(err.message, /ltj_secret_csrf_zzz/, '表單欄位值不得外洩');
      assert.doesNotMatch(err.message, /ltj_pat_SECRET_zzz/, '權杖不得外洩');
      assert.equal(err.litejiraTransport.status, 401);
      return true;
    });
});

test('GH-339：連線層例外的訊息也過脫敏，唯讀故可重試', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    throw new Error('connect fail ltj_pat_INEXC_zzz');
  };

  await assert.rejects(
    () => getLiteJiraApiV1(fetchImpl, config.v1ApiUrl, config.token,
      ['attachments', ATTACHMENT_ID, 'text'], {}, { sleep: async () => {} }),
    (err) => {
      assert.doesNotMatch(err.message, /ltj_pat_INEXC_zzz/);
      return true;
    });
  assert.equal(attempts, 3, '唯讀 GET 可安全重試（1 次 + 2 次重試）');
});

test('GH-339：業務錯誤不重試（4xx 直接回信封）', async () => {
  const { calls, fetchImpl } = recordingFetch(
    jsonReply(404, { error: { code: 'not_found', message: '查無此附件' } }));

  await callTool(TOOL, { attachmentId: ATTACHMENT_ID }, config, fetchImpl);

  assert.equal(calls.length, 1, '伺服器已經答了，重問不會有別的答案');
});

// ── ③ 錯誤分流 ──

test('GH-339：404 回 isError 並說明三種情況共用同一句', async () => {
  const { fetchImpl } = recordingFetch(
    jsonReply(404, { error: { code: 'not_found', message: '查無此附件' } }));

  const result = await callTool(TOOL, { attachmentId: ATTACHMENT_ID }, config, fetchImpl);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /\[not_found\] 查無此附件/);
  assert.match(result.content[0].text, /封存/);
});

test('GH-339：403 的 hint 說明權限與下載同級', async () => {
  const { fetchImpl } = recordingFetch(
    jsonReply(403, { error: { code: 'permission_denied', message: '沒有檢視權限', details: { type: 'spec' } } }));

  const result = await callTool(TOOL, { attachmentId: ATTACHMENT_ID }, config, fetchImpl);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /\[permission_denied\]/);
  assert.match(result.content[0].text, /同級/);
});

test('GH-339：五種 422 reason 各給各的下一步，分流只看 details.reason', async () => {
  const cases = [
    ['not_text', /下載原檔/],
    ['too_large', /2 MiB/],
    ['not_utf8', /Big5|轉碼/],
    ['external_link', /不在 LiteJira/],
    ['offset_not_boundary', /nextByteOffset/],
    ['offset_beyond_eof', /offset=0/]
  ];

  for (const [reason, expected] of cases) {
    const { fetchImpl } = recordingFetch(jsonReply(422, {
      // 訊息字串刻意是同一句：分流不准靠它
      error: { code: 'invalid_argument', message: '不可讀', details: { reason } }
    }));
    const result = await callTool(TOOL, { attachmentId: ATTACHMENT_ID }, config, fetchImpl);

    assert.equal(result.isError, true, reason + ' 應回 isError');
    assert.match(result.content[0].text, expected, reason + ' 的 hint 不對');
  }
});

test('GH-339：422 沒有 reason 時退回參數說明，不假裝知道原因', async () => {
  const { fetchImpl } = recordingFetch(jsonReply(422, {
    error: { code: 'invalid_argument', message: 'limit 必須是 4～262144 的整數（位元組）', details: { field: 'limit' } }
  }));

  const result = await callTool(TOOL, { attachmentId: ATTACHMENT_ID }, config, fetchImpl);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /details\.field/);
});

test('GH-339：500 的 hint 不叫人重試洗版', async () => {
  const { fetchImpl } = recordingFetch(
    jsonReply(500, { error: { code: 'internal', message: '伺服器內部錯誤' } }));

  const result = await callTool(TOOL, { attachmentId: ATTACHMENT_ID }, config, fetchImpl);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requestId/);
});

test('GH-339：既有 Apps Script 工具的 hint 沒被動到', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ ok: false, error: { code: 'AUTH_FAILED', message: 'bad token' } })
  });

  const result = await callTool('litejira.searchTickets', { limit: 1 }, config, fetchImpl);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /\[AUTH_FAILED\] bad token/);
  assert.match(result.content[0].text, /credentials/);
});
