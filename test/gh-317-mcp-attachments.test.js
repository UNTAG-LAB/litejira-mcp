'use strict';

// GH-317：附件的「拿得到檔」與「放得上檔」。
//
// 這一包要守住的事情，依「出錯的代價」排序：
//   1. PAT 不得出現在任何 URL 或工具輸出裡（貼出去就外洩，而且收不回來）。
//   2. 上傳不得自動重試 —— 這個端點沒有 Idempotency-Key（後端 422），重送就是真的再傳一份。
//   3. 不得帶著 Bearer 跟隨 redirect，也不得把任意外部 URL 當檔案來源抓。
//   4. 本機檔案守門（普通檔案 / 非空 / 不超過上限）必須在送出「之前」就擋下。
//   5. 既有附件的舊欄位（含 legacy url）一個都不能掉，新的取檔 URL 必須是非 null 的正確值。
//
// 全程用假 transport：不連線、不寫入、不讀憑證。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { callTool, listTools, getConfigFromEnv } = require('../litejira-mcp-server');
const {
  LiteJiraTransportError,
  buildUploadRequest,
  attachmentContentUrls,
  uploadAttachment,
  DEFAULT_MAX_UPLOAD_BYTES,
  UPLOAD_BYTES_CEILING
} = require('../litejira-v1-transport');

const TOKEN = 'ltj_pat_SECRET_do_not_leak_0123456789';
const BASE = 'https://litejira.example.com';
const ATT_ID = '11111111-2222-4333-8444-555555555555';

function cfg(extra) {
  return Object.assign({
    apiUrl: BASE,
    token: TOKEN,
    project: '',
    enableWrites: true,
    maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES
  }, extra || {});
}

// 假 fetch：記下每一發請求（含把 body 串流收成 Buffer），回一個可控的假 Response。
function recorder(options) {
  const opts = options || {};
  const calls = [];
  const fetchImpl = async function (url, init) {
    const entry = { url: url, init: init, method: init.method, headers: init.headers };
    if (init.body && typeof init.body[Symbol.asyncIterator] === 'function') {
      const chunks = [];
      for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
      entry.body = Buffer.concat(chunks);
    } else {
      entry.body = init.body;
    }
    calls.push(entry);
    if (opts.throws) throw opts.throws;
    const payload = typeof opts.payload === 'function' ? opts.payload(calls.length) : opts.payload;
    return {
      status: opts.status === undefined ? 200 : opts.status,
      text: async function () { return payload === undefined ? '' : JSON.stringify(payload); }
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function neverFetch() {
  return async function () { throw new Error('不應該發出任何請求'); };
}

async function tmpFile(name, contents) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ltj-att-'));
  const file = path.join(dir, name);
  await fsp.writeFile(file, contents);
  return { dir: dir, file: file };
}

function structured(result) {
  return result.structuredContent;
}

// 把整個回應（文字 + 結構化）攤平成一個字串，用來驗「PAT 一個字元都沒漏出去」。
function flatten(result) {
  return JSON.stringify(result);
}

// 🔴 **附件在工單本體裡是拿不到的**：後端的 `TicketDetail` 契約上沒有 attachments 欄
//（D-165：舊 getAttachments 只被 webapp 內部呼叫，對外契約基準的 getTicket 就沒有附件欄）。
// 唯一的來源是專屬路由 `GET /api/v1/tickets/{ticket}/attachments`，它回的是
// `{ data: { items: [...] } }` —— **完整集合、不分頁**（每單上限個位數，與關注者同級）。
// 這裡的假回應逐欄對齊 `TicketAttachmentItem`（read-queries.ts）：id / storage / name /
// url / uploadedBy / createdAt 六欄，不多不少。
// ⚠️ 以「工單回應裡有 attachments[]」當假資料是無效的測試：那個形狀後端永遠不會回，
// 照著它寫的實作在真的後端上只會拿到 undefined，而測試會一路綠燈。
const ATTACHMENTS_PAYLOAD = {
  data: {
    items: [
      {
        id: ATT_ID,
        // 連結型：url 有值。共用硬碟型的 url 是 null（R-F03），靠 storage 分辨。
        storage: 'legacy_link',
        name: '崩潰畫面.png',
        url: 'https://drive.example.com/file/d/xyz/view',
        uploadedBy: { id: 'ffffffff-1111-4222-8333-444444444444', name: '小明' },
        createdAt: '2026-09-01T10:00:00.000000Z'
      }
    ]
  }
};

// ── 1. 工具面：公告、唯讀 / 寫入標記、不收的參數 ──────────────────────────

test('GH-317：兩個附件工具都公告出來，讀的標唯讀、寫的標非冪等', function () {
  const byName = {};
  listTools().forEach(function (t) { byName[t.name] = t; });

  const read = byName['litejira.getAttachments'];
  assert.ok(read, 'getAttachments 應該出現在 tools/list');
  assert.strictEqual(read.annotations.readOnlyHint, true);

  const write = byName['litejira.uploadAttachment'];
  assert.ok(write, 'uploadAttachment 應該出現在 tools/list');
  assert.notStrictEqual(write.annotations.readOnlyHint, true);
  // 非冪等要標出來：標成冪等會誘導主機在逾時後自動重送，而這個端點重送＝再傳一份。
  assert.strictEqual(write.annotations.idempotentHint, false);
  assert.deepStrictEqual(write.inputSchema.required, ['ticketId', 'filePath']);
  assert.ok(!write.inputSchema.properties.idempotencyKey, '上傳 schema 不得公開 idempotencyKey');
  assert.match(write.description, /Idempotency-Key/);
  assert.match(write.description, /422/);
});

test('GH-317：工具說明講清楚兩個取檔入口各自要什麼認證，且都不含 PAT', function () {
  const read = listTools().find(function (t) { return t.name === 'litejira.getAttachments'; });
  assert.match(read.description, /Bearer/);
  assert.match(read.description, /BROWSER/);
  assert.match(read.description, /NO URL EVER CONTAINS THE PAT/);
  assert.ok(JSON.stringify(listTools()).indexOf(TOKEN) === -1, '工具清單不得夾帶 PAT');
});

test('GH-317：寫入開關關閉時，上傳在本機被擋下，一發都不送', async function () {
  const written = await tmpFile('a.txt', 'hello');
  await assert.rejects(
    callTool('litejira.uploadAttachment',
      { ticketId: 'BUG-481', filePath: written.file }, cfg({ enableWrites: false }), neverFetch()),
    function (err) { return err.code === 'WRITES_DISABLED'; });
});

test('GH-317：唯讀的 getAttachments 不受寫入開關影響（關著也讀得到）', async function () {
  const fetchImpl = recorder({ payload: ATTACHMENTS_PAYLOAD });
  const result = await callTool('litejira.getAttachments',
    { ticketId: 'BUG-481' }, cfg({ enableWrites: false }), fetchImpl);
  assert.ok(!result.isError);
  assert.strictEqual(fetchImpl.calls.length, 1);
  assert.strictEqual(fetchImpl.calls[0].method, 'GET');
});

// 🔴 契約回歸：打的是**附件專屬路由**，不是工單本體。
// 這一條是本包最容易無聲失效的地方——讀 `GET /tickets/{ticket}` 再挖 attachments[]
// 在假資料下看起來會動，在真的後端上永遠是 undefined（TicketDetail 沒有那一欄）。
test('GH-317：getAttachments 打的是 /tickets/{ticket}/attachments，不是工單本體', async function () {
  const fetchImpl = recorder({ payload: ATTACHMENTS_PAYLOAD });
  await callTool('litejira.getAttachments', { ticketId: 'BUG-481' }, cfg(), fetchImpl);
  assert.strictEqual(fetchImpl.calls.length, 1);
  const url = new URL(fetchImpl.calls[0].url);
  assert.strictEqual(url.pathname, '/api/v1/tickets/BUG-481/attachments');
  // 不分頁：這條路由回完整集合，帶 limit / cursor / order 都是叫錯端點。
  assert.strictEqual(url.search, '');
});

test('GH-317：上傳工具不收 idempotencyKey，被擋下時講明後端會回 422', async function () {
  const written = await tmpFile('a.txt', 'hello');
  await assert.rejects(
    callTool('litejira.uploadAttachment',
      { ticketId: 'BUG-481', filePath: written.file, idempotencyKey: 'k'.repeat(20) },
      cfg(), neverFetch()),
    function (err) {
      return err.code === 'VALIDATION_FAILED' && /Idempotency-Key/.test(err.message) && /422/.test(err.message);
    });
});

test('GH-317：filePath 不收 URL —— 不代抓任何遠端內容', async function () {
  for (const bad of ['https://evil.example.com/x.png', 'http://127.0.0.1:9/x', 'file:///etc/passwd']) {
    await assert.rejects(
      callTool('litejira.uploadAttachment', { ticketId: 'BUG-481', filePath: bad }, cfg(), neverFetch()),
      function (err) {
        return err.code === 'VALIDATION_FAILED' && /不會去下載任何遠端內容/.test(err.message);
      }, bad);
  }
});

// ── 2. 既有附件：舊欄位全留，新 URL 非 null 且正確 ────────────────────────

test('GH-317：getAttachments 保留每一個舊欄位與 legacy 連結，另外補上兩個取檔入口', async function () {
  const fetchImpl = recorder({ payload: ATTACHMENTS_PAYLOAD });
  const result = await callTool('litejira.getAttachments', { ticketId: 'BUG-481' }, cfg(), fetchImpl);
  const out = structured(result);

  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.count, 1);
  // 不分頁是這條路由的契約，回應要講出來（呼叫端才不會去找 nextCursor）。
  assert.strictEqual(out.paginated, false);
  const item = out.attachments[0];
  // 舊欄位逐一比對：新增欄位不得順手改名或丟掉既有欄位。
  const original = ATTACHMENTS_PAYLOAD.data.items[0];
  Object.keys(original).forEach(function (key) {
    assert.deepStrictEqual(item[key], original[key], '舊欄位 ' + key + ' 必須原樣保留');
  });

  assert.strictEqual(item.links.legacy, original.url, 'legacy 連結要原樣回著');
  assert.strictEqual(item.links.web, BASE + '/api/web/attachments/' + ATT_ID + '/content');
  assert.strictEqual(item.links.api, BASE + '/api/v1/attachments/' + ATT_ID + '/content');
  // 「沒有直接下載工具」不等於可以回 null：URL 一定要是能用的真值。
  assert.ok(item.links.web && item.links.api, '取檔 URL 不得是 null');
  assert.match(item.links.webAuth, /browser-session/);
  assert.match(item.links.apiAuth, /bearer-pat/);
});

test('GH-317：附件回應裡不得出現 PAT（URL、header 說明、任何角落都不行）', async function () {
  const fetchImpl = recorder({ payload: ATTACHMENTS_PAYLOAD });
  const result = await callTool('litejira.getAttachments', { ticketId: 'BUG-481' }, cfg(), fetchImpl);
  const text = flatten(result);
  assert.ok(text.indexOf(TOKEN) === -1, '回應夾帶了 PAT');
  assert.ok(text.indexOf('Bearer ' + TOKEN) === -1);
  // header 說明要講「放什麼」，但不能把值填進去。
  assert.match(structured(result).upload.headers.Authorization, /Bearer <.*PAT>/);
});

test('GH-317：回應同時帶上傳端點的自述（方法 / URL 樣板 / 必要 header），且明講不可帶 Idempotency-Key', async function () {
  const fetchImpl = recorder({ payload: ATTACHMENTS_PAYLOAD });
  const result = await callTool('litejira.getAttachments', { ticketId: 'BUG-481' }, cfg(), fetchImpl);
  const upload = structured(result).upload;
  assert.strictEqual(upload.method, 'POST');
  assert.strictEqual(upload.url,
    BASE + '/api/v1/tickets/BUG-481/attachments/upload?name={ENCODED_FILENAME}');
  assert.ok(upload.headers['Content-Type']);
  assert.match(upload.body, /raw bytes/);
  assert.match(upload.forbiddenHeaders['Idempotency-Key'], /422/);
  assert.match(upload.unknownOutcome, /不要自動重試/);
});

test('GH-317：回應沒有 items 陣列時，回 null 並講明，不偽造成「沒有附件」', async function () {
  const fetchImpl = recorder({ payload: { data: {} } });
  const result = await callTool('litejira.getAttachments', { ticketId: 'BUG-1' }, cfg(), fetchImpl);
  const out = structured(result);
  assert.strictEqual(out.attachments, null);
  assert.strictEqual(out.count, null);
  assert.match(out.unavailable, /不等於/);
});

// 空集合與「回應沒講附件」是兩件事：items: [] 就是真的沒有附件，要回 0 而不是 null。
test('GH-317：items 是空陣列時回 count=0，不與「沒講附件」混為一談', async function () {
  const fetchImpl = recorder({ payload: { data: { items: [] } } });
  const out = structured(await callTool('litejira.getAttachments', { ticketId: 'BUG-1' }, cfg(), fetchImpl));
  assert.strictEqual(out.count, 0);
  assert.deepStrictEqual(out.attachments, []);
  assert.strictEqual(out.unavailable, undefined);
});

// 共用硬碟型：url 是 null（R-F03 不讓硬碟識別碼與原始連結離開伺服器），
// 但取檔入口照樣要組得出來——否則這一型的附件在助手眼中等於「看得到、拿不到」。
test('GH-317：url 為 null 的共用硬碟型附件，links.legacy 是 null 但兩個取檔入口仍有效', async function () {
  const fetchImpl = recorder({
    payload: {
      data: {
        items: [{
          id: ATT_ID, storage: 'shared_drive', name: '設計稿.png',
          url: null, uploadedBy: null, createdAt: null
        }]
      }
    }
  });
  const out = structured(await callTool('litejira.getAttachments', { ticketId: 'BUG-481' }, cfg(), fetchImpl));
  const item = out.attachments[0];
  assert.strictEqual(item.storage, 'shared_drive');
  assert.strictEqual(item.url, null);
  assert.strictEqual(item.links.legacy, null);
  assert.strictEqual(item.links.api, BASE + '/api/v1/attachments/' + ATT_ID + '/content');
  assert.strictEqual(item.links.web, BASE + '/api/web/attachments/' + ATT_ID + '/content');
});

test('GH-317：附件 id 進 URL 一律 escape（不讓外部字串拼出路徑穿越）', function () {
  const urls = attachmentContentUrls(BASE, '../../admin/secrets');
  assert.strictEqual(urls.api, BASE + '/api/v1/attachments/..%2F..%2Fadmin%2Fsecrets/content');
  assert.strictEqual(urls.web, BASE + '/api/web/attachments/..%2F..%2Fadmin%2Fsecrets/content');
});

// ── 3. 上傳請求的形狀：URL escape / MIME / 檔名 / header ────────────────────

test('GH-317：上傳 URL 的檔名走 encodeURIComponent，工單參照也 escape，且 URL 內沒有 PAT', function () {
  const req = buildUploadRequest({
    baseUrl: BASE, token: TOKEN, ticket: 'BUG-481',
    name: '崩潰 報告&v1.png', contentType: 'image/png', size: 10
  });
  assert.strictEqual(req.method, 'POST');
  const url = new URL(req.url);
  assert.strictEqual(url.pathname, '/api/v1/tickets/BUG-481/attachments/upload');
  assert.strictEqual(url.searchParams.get('name'), '崩潰 報告&v1.png');
  assert.ok(req.url.indexOf(' ') === -1 && req.url.indexOf('&v1') === -1, '空白與 & 必須被編碼');
  // 空白編成 %20（不是 '+'）：兩種 query parser 都還原得回同一個檔名。
  assert.ok(req.url.indexOf('%20') !== -1 && req.url.indexOf('+') === -1);
  assert.ok(req.url.indexOf(TOKEN) === -1, 'URL 不得含 PAT');
  assert.strictEqual(req.headers.Authorization, 'Bearer ' + TOKEN);
  assert.strictEqual(req.headers['Content-Type'], 'image/png');
  assert.ok(!Object.prototype.hasOwnProperty.call(req.headers, 'Idempotency-Key'));
});

test('GH-317：檔名不得含路徑分隔符 / 控制字元，MIME 不得夾帶注入字元', function () {
  const base = { baseUrl: BASE, token: TOKEN, ticket: 'BUG-481', contentType: 'image/png' };
  [['../etc/passwd', /路徑分隔符/], ['a\r\nb.png', /控制字元/], ['', /非空字串/]].forEach(function (pair) {
    assert.throws(function () { buildUploadRequest(Object.assign({}, base, { name: pair[0] })); },
      function (err) { return err instanceof LiteJiraTransportError && pair[1].test(err.message); },
      JSON.stringify(pair[0]));
  });
  ['image/png\r\nX-Evil: 1', 'image png', 'image/png; charset=utf-8', 'notamime'].forEach(function (bad) {
    assert.throws(function () {
      buildUploadRequest({ baseUrl: BASE, token: TOKEN, ticket: 'BUG-481', name: 'a.png', contentType: bad });
    }, function (err) { return err instanceof LiteJiraTransportError && /MIME/.test(err.message); }, bad);
  });
});

test('GH-317：buildUploadRequest 收到 Idempotency-Key 一律拒絕（後端會 422）', function () {
  assert.throws(function () {
    buildUploadRequest({
      baseUrl: BASE, token: TOKEN, ticket: 'BUG-481', name: 'a.png',
      contentType: 'image/png', idempotencyKey: 'k'.repeat(20)
    });
  }, function (err) { return err instanceof LiteJiraTransportError && /422/.test(err.message); });
});

test('GH-317：上傳送出的是原始位元組，檔名與 MIME 與檔案相符', async function () {
  // 刻意包含 0x00 與非 UTF-8 的位元組：走錯路徑（例如被當字串處理）就會壞掉。
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x42]);
  const written = await tmpFile('崩潰 畫面.png', bytes);
  const fetchImpl = recorder({ status: 201, payload: { data: { id: ATT_ID, name: '崩潰 畫面.png' } } });

  const result = await callTool('litejira.uploadAttachment',
    { ticketId: 'BUG-481', filePath: written.file }, cfg(), fetchImpl);

  assert.ok(!result.isError, JSON.stringify(result));
  assert.strictEqual(fetchImpl.calls.length, 1, '上傳只能打一發');
  const call = fetchImpl.calls[0];
  assert.strictEqual(call.method, 'POST');
  assert.ok(call.body.equals(bytes), '送出的必須是檔案的原始位元組');
  assert.strictEqual(call.headers['Content-Type'], 'image/png', 'MIME 由副檔名推得');
  assert.strictEqual(call.headers['Content-Length'], String(bytes.length));
  assert.strictEqual(new URL(call.url).searchParams.get('name'), '崩潰 畫面.png');
  assert.strictEqual(call.init.redirect, 'manual', '不得跟隨 redirect');
  assert.ok(!Object.prototype.hasOwnProperty.call(call.headers, 'Idempotency-Key'));

  const out = structured(result);
  assert.strictEqual(out.bytes, bytes.length);
  assert.strictEqual(out.contentType, 'image/png');
  assert.strictEqual(out.name, '崩潰 畫面.png');
  assert.strictEqual(out.idempotencyKey, null);
  // 內容本身不得回到 JSON 裡。
  assert.ok(flatten(result).indexOf(bytes.toString('base64')) === -1);
  assert.ok(flatten(result).indexOf(TOKEN) === -1, '回應夾帶了 PAT');
});

// 後端上傳成功是 201 `{ data: <新建的那一筆附件> }`（與清單同一個投影）。
// 那一筆要與 getAttachments 走同一個 enrich，否則剛上傳完的檔案是唯一一個
// 「拿不到取檔 URL」的附件——得再列一次附件才補得回來。
test('GH-317：上傳成功回的 data 是新建的那一筆附件，且同樣附上取檔入口', async function () {
  const written = await tmpFile('a.png', Buffer.from([1, 2, 3]));
  const fetchImpl = recorder({
    status: 201,
    payload: {
      data: {
        id: ATT_ID, storage: 'shared_drive', name: 'a.png',
        url: null, uploadedBy: { id: 'ffffffff-1111-4222-8333-444444444444', name: '小明' },
        createdAt: '2026-09-23T08:00:00.000000Z'
      }
    }
  });
  const out = structured(await callTool('litejira.uploadAttachment',
    { ticketId: 'BUG-481', filePath: written.file }, cfg(), fetchImpl));

  assert.strictEqual(out.status, 201);
  // 後端回的欄位一個不動。
  assert.strictEqual(out.data.id, ATT_ID);
  assert.strictEqual(out.data.storage, 'shared_drive');
  assert.strictEqual(out.data.createdAt, '2026-09-23T08:00:00.000000Z');
  assert.deepStrictEqual(out.data.uploadedBy, { id: 'ffffffff-1111-4222-8333-444444444444', name: '小明' });
  // 另外附上的取檔入口與 getAttachments 同一組。
  assert.strictEqual(out.data.links.api, BASE + '/api/v1/attachments/' + ATT_ID + '/content');
  assert.strictEqual(out.data.links.web, BASE + '/api/web/attachments/' + ATT_ID + '/content');
  assert.ok(flatten({ out: out }).indexOf(TOKEN) === -1, '回應夾帶了 PAT');
});

test('GH-317：大塊檔案仍是完整位元組（跨多個 chunk 也不能錯位）', async function () {
  const bytes = Buffer.alloc(200 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const written = await tmpFile('big.bin', bytes);
  const fetchImpl = recorder({ payload: { data: { id: ATT_ID } } });
  await callTool('litejira.uploadAttachment', { ticketId: 'BUG-481', filePath: written.file }, cfg(), fetchImpl);
  assert.ok(fetchImpl.calls[0].body.equals(bytes));
  assert.strictEqual(fetchImpl.calls[0].headers['Content-Type'], 'application/octet-stream',
    '推不出來就用 octet-stream，不亂猜');
});

// ── 4. 本機檔案守門：全部在送出「之前」擋下 ───────────────────────────────

test('GH-317：檔案不存在 → 本機擋下，不送出，也不轉述系統訊息（可能夾帶路徑以外的資訊）', async function () {
  const fetchImpl = recorder({ payload: { data: {} } });
  const missing = path.join(os.tmpdir(), 'ltj-does-not-exist-' + Date.now() + '.png');
  const result = await callTool('litejira.uploadAttachment',
    { ticketId: 'BUG-481', filePath: missing }, cfg(), fetchImpl);
  assert.ok(result.isError);
  assert.strictEqual(structured(result).error.code, 'file_unreadable');
  assert.strictEqual(structured(result).uploaded, 'no');
  assert.strictEqual(fetchImpl.calls.length, 0, '一發都不該送出');
});

test('GH-317：目錄不是普通檔案 → 本機擋下（沒有可預期的長度）', async function () {
  const written = await tmpFile('a.txt', 'x');
  const fetchImpl = recorder({ payload: { data: {} } });
  const result = await callTool('litejira.uploadAttachment',
    { ticketId: 'BUG-481', filePath: written.dir }, cfg(), fetchImpl);
  assert.ok(result.isError);
  assert.strictEqual(structured(result).error.code, 'file_not_regular');
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test('GH-317：0 byte 檔案 → 本機擋下', async function () {
  const written = await tmpFile('empty.txt', '');
  const fetchImpl = recorder({ payload: { data: {} } });
  const result = await callTool('litejira.uploadAttachment',
    { ticketId: 'BUG-481', filePath: written.file }, cfg(), fetchImpl);
  assert.ok(result.isError);
  assert.strictEqual(structured(result).error.code, 'file_empty');
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test('GH-317：超過上限 → 本機擋下，錯誤裡講出實際大小與上限', async function () {
  const written = await tmpFile('big.bin', Buffer.alloc(4096));
  const fetchImpl = recorder({ payload: { data: {} } });
  const result = await callTool('litejira.uploadAttachment',
    { ticketId: 'BUG-481', filePath: written.file, maxBytes: 1024 }, cfg(), fetchImpl);
  assert.ok(result.isError);
  assert.strictEqual(structured(result).error.code, 'file_too_large');
  assert.strictEqual(structured(result).error.details.size, 4096);
  assert.strictEqual(structured(result).error.details.maxBytes, 1024);
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test('GH-317：上限本身有天花板，設定值超出範圍一律當面報錯', function () {
  assert.throws(function () {
    getConfigFromEnv({ LTJ_API_URL: BASE, LTJ_API_TOKEN: TOKEN, LTJ_MCP_MAX_UPLOAD_BYTES: '0' });
  }, function (err) { return err.code === 'CONFIG_ERROR'; });
  assert.throws(function () {
    getConfigFromEnv({
      LTJ_API_URL: BASE, LTJ_API_TOKEN: TOKEN,
      LTJ_MCP_MAX_UPLOAD_BYTES: String(UPLOAD_BYTES_CEILING + 1)
    });
  }, function (err) { return err.code === 'CONFIG_ERROR'; });
  const ok = getConfigFromEnv({ LTJ_API_URL: BASE, LTJ_API_TOKEN: TOKEN });
  assert.strictEqual(ok.maxUploadBytes, DEFAULT_MAX_UPLOAD_BYTES);
});

// ── 5. 連線層：redirect / 逾時 / 結果不明的善後 ───────────────────────────

test('GH-317：上傳撞到 redirect 時不跟隨（不把 Bearer 與檔案內容帶去別的地方）', async function () {
  const written = await tmpFile('a.png', Buffer.from([1, 2, 3]));
  const fetchImpl = recorder({ status: 302, payload: undefined });
  const result = await callTool('litejira.uploadAttachment',
    { ticketId: 'BUG-481', filePath: written.file }, cfg(), fetchImpl);
  assert.ok(result.isError);
  assert.strictEqual(structured(result).error.code, 'redirect_blocked');
  assert.strictEqual(fetchImpl.calls.length, 1, '不得對 Location 再發一次');
  assert.strictEqual(fetchImpl.calls[0].init.redirect, 'manual');
  assert.ok(flatten(result).indexOf(TOKEN) === -1);
});

test('GH-317：逾時只打一發就收斂，不自動重試', async function () {
  const written = await tmpFile('a.png', Buffer.from([1, 2, 3]));
  let calls = 0;
  const hangingFetch = async function () {
    calls += 1;
    return new Promise(function () { /* 永遠不 settle：模擬對方收下了但不回應 */ });
  };
  await assert.rejects(
    uploadAttachment({
      fetch: hangingFetch, baseUrl: BASE, token: TOKEN, ticket: 'BUG-481',
      filePath: written.file, name: 'a.png', contentType: 'image/png', timeoutMs: 30
    }),
    function (err) { return err instanceof LiteJiraTransportError && err.code === 'timeout'; });
  assert.strictEqual(calls, 1, '逾時後不得再送一次');
});

test('GH-317：結果不明時回 uploaded=unknown，並要求先對帳而不是重送', async function () {
  const written = await tmpFile('a.png', Buffer.from([1, 2, 3]));
  const fetchImpl = recorder({ throws: new Error('socket hang up（含內部細節，不該被轉述）') });
  const result = await callTool('litejira.uploadAttachment',
    { ticketId: 'BUG-481', filePath: written.file }, cfg(), fetchImpl);

  assert.ok(result.isError);
  const out = structured(result);
  assert.strictEqual(out.error.code, 'network_error');
  assert.strictEqual(out.uploaded, 'unknown');
  assert.match(out.recovery, /不要自動重試/);
  assert.match(out.recovery, /getAttachments/);
  assert.strictEqual(fetchImpl.calls.length, 1, '本層不得自己重試');
  // 原始錯誤訊息不轉述（它可能夾帶 URL / 憑證 / 他人資料）。
  assert.ok(flatten(result).indexOf('socket hang up') === -1);
  assert.ok(flatten(result).indexOf(TOKEN) === -1);
});

test('GH-317：伺服器明確拒絕（4xx）時回 uploaded=no，錯誤碼原樣轉出', async function () {
  const written = await tmpFile('a.png', Buffer.from([1, 2, 3]));
  const fetchImpl = recorder({
    status: 403,
    payload: { error: { code: 'permission_denied', message: '沒有上傳附件的權限' } }
  });
  const result = await callTool('litejira.uploadAttachment',
    { ticketId: 'BUG-481', filePath: written.file }, cfg(), fetchImpl);
  assert.ok(result.isError);
  assert.strictEqual(structured(result).error.code, 'permission_denied');
  assert.strictEqual(fetchImpl.calls.length, 1);
});

// ── 6. base URL 的 origin 規則沿用既有設定守門 ─────────────────────────────

test('GH-317：取檔 URL 沿用 base URL 的 origin 規則（對外站台必須 https）', function () {
  assert.throws(function () { attachmentContentUrls('http://litejira.example.com', ATT_ID); },
    function (err) { return err instanceof LiteJiraTransportError && err.code === 'invalid_base_url'; });
  // 明確 loopback 的 http 仍然可用（本機開發）。
  const local = attachmentContentUrls('http://127.0.0.1:8080', ATT_ID);
  assert.strictEqual(local.web, 'http://127.0.0.1:8080/api/web/attachments/' + ATT_ID + '/content');
});

test('GH-317：站台掛在子路徑時，web 取檔連結也要保留那層前綴（不能只用 origin）', function () {
  const urls = attachmentContentUrls('https://intranet.example.com/litejira', ATT_ID);
  assert.strictEqual(urls.api,
    'https://intranet.example.com/litejira/api/v1/attachments/' + ATT_ID + '/content');
  assert.strictEqual(urls.web,
    'https://intranet.example.com/litejira/api/web/attachments/' + ATT_ID + '/content');
});

test('GH-317：上傳收到契約內 500 仍視為結果不明，先對帳', async function () {
  const written = await tmpFile('server-error.png', Buffer.from([1, 2, 3]));
  const fetchImpl = recorder({ status: 500, payload: { error: { code: 'internal', message: '伺服器內部錯誤' } } });
  const result = await callTool('litejira.uploadAttachment',
    { ticketId: 'BUG-481', filePath: written.file }, cfg(), fetchImpl);
  assert.strictEqual(structured(result).uploaded, 'unknown');
  assert.match(structured(result).recovery, /不要自動重試/);
  assert.strictEqual(fetchImpl.calls.length, 1);
});

test('GH-317：上傳自述保留子路徑部署前綴', async function () {
  const result = await callTool('litejira.getAttachments', { ticketId: 'BUG-481' },
    cfg({ apiUrl: 'https://intranet.example.com/litejira' }),
    recorder({ payload: { data: { items: [] } } }));
  assert.strictEqual(structured(result).upload.url,
    'https://intranet.example.com/litejira/api/v1/tickets/BUG-481/attachments/upload?name={ENCODED_FILENAME}');
});

test('GH-317：工具可設定上傳期限，逾時仍不重試', async function () {
  const written = await tmpFile('timeout.png', Buffer.from([1, 2, 3]));
  let calls = 0;
  const result = await callTool('litejira.uploadAttachment',
    { ticketId: 'BUG-481', filePath: written.file, timeoutMs: 15 }, cfg(),
    async function () { calls++; return new Promise(function () {}); });
  assert.strictEqual(structured(result).error.code, 'timeout');
  assert.strictEqual(structured(result).uploaded, 'unknown');
  assert.strictEqual(calls, 1);
});

// ── 7. 對本機 stub 跑一次真的 fetch ───────────────────────────────────────
//
// 上面的假 fetch 驗得了「我們交出去什麼」，驗不了「runtime 收不收」：
// 串流 body 在 undici 需要 duplex:'half'，漏了會在真的送出時才爆。
// 所以這一條對 127.0.0.1 的 stub 用 runtime 內建的 fetch 跑一次完整往返（不連外網）。
test('GH-317：對本機 stub 的真實往返 —— 串流 body 真的送得出去，位元組相符', async function (t) {
  const http = require('node:http');
  const received = [];
  const server = http.createServer(function (req, res) {
    const chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      received.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks)
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { id: ATT_ID, name: 'round-trip.bin' } }));
    });
  });
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  t.after(function () { server.close(); });

  const bytes = Buffer.alloc(130 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
  const written = await tmpFile('round trip.bin', bytes);

  const result = await uploadAttachment({
    baseUrl: 'http://127.0.0.1:' + server.address().port,
    token: TOKEN,
    ticket: 'BUG-481',
    filePath: written.file,
    name: 'round trip.bin',
    contentType: 'application/octet-stream'
  });

  assert.strictEqual(result.status, 201);
  assert.strictEqual(result.data.id, ATT_ID);
  assert.strictEqual(received.length, 1);
  assert.ok(received[0].body.equals(bytes), 'server 收到的位元組要與檔案一致');
  assert.strictEqual(received[0].method, 'POST');
  // 空白必須是 %20 而不是 '+'：'+' 只有 form-urlencoded parser 才還原得回空白。
  assert.strictEqual(received[0].url, '/api/v1/tickets/BUG-481/attachments/upload?name=round%20trip.bin');
  assert.strictEqual(received[0].headers.authorization, 'Bearer ' + TOKEN);
  assert.strictEqual(received[0].headers['content-type'], 'application/octet-stream');
  assert.ok(!received[0].headers['idempotency-key'], '不得帶 Idempotency-Key');
});

test('GH-317：臨時檔清理（保持 tmp 乾淨，不影響其他測試）', async function () {
  const entries = await fsp.readdir(os.tmpdir());
  const mine = entries.filter(function (n) { return n.indexOf('ltj-att-') === 0; });
  for (const name of mine) {
    fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
  }
  assert.ok(true);
});
