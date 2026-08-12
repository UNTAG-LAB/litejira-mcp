const test = require('node:test');
const assert = require('node:assert');
const { postLiteJiraApi } = require('../ltj-cli');

// 造一個假回應。headers 用 Map 模擬 fetch 的 Headers 介面。
function reply(status, body, headers) {
  const map = new Map(Object.entries(headers || {}));
  return {
    status,
    ok: status >= 200 && status < 300,
    url: (headers && headers.__url) || '',
    headers: { get: (k) => map.get(String(k).toLowerCase()) || null },
    text: async () => body
  };
}

const JSON_OK = JSON.stringify({ ok: true, data: { count: 1 } });
const REDIRECT = { location: 'https://script.googleusercontent.com/macros/echo?key=abc' };
// Google 的「找不到網頁 / 雲端硬碟」錯誤頁（實測樣本，見 GH-303）
const DRIVE_404 = '<!DOCTYPE html><html><head><title>找不到網頁</title></head><body>很抱歉，目前無法開啟這個檔案。</body></html>';
// 導向鏈繞回 /exec 時 doGet 回的頁面（實測樣本，見 GH-303）
const DENIED_HTML = '<!DOCTYPE html><html><head><title>LiteJira — 無權限</title></head><body>無權限</body></html>';

const noSleep = async () => {};

test('GH-303：第二段 404 後重取成功，指令碼不會被再次執行', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: (options && options.method) || 'GET' });
    if ((options && options.method) === 'POST') return reply(302, '', REDIRECT);
    // 第一次取暫存結果失敗，第二次成功
    return calls.filter((c) => c.method === 'GET').length === 1
      ? reply(404, DRIVE_404, { 'content-type': 'text/html' })
      : reply(200, JSON_OK, { 'content-type': 'application/json' });
  };

  const envelope = await postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, { sleep: noSleep });

  assert.deepEqual(envelope, { ok: true, data: { count: 1 } });
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1, '第一段只能打一次');
  assert.equal(calls.filter((c) => c.method === 'GET').length, 2, '第二段重取一次');
});

test('GH-303：寫入動作在第二段失敗後絕不重發第一段', async () => {
  const posts = [];
  const fetchImpl = async (url, options) => {
    if ((options && options.method) === 'POST') {
      posts.push(url);
      return reply(302, '', REDIRECT);
    }
    return reply(404, DRIVE_404, { 'content-type': 'text/html' });
  };

  await assert.rejects(
    () => postLiteJiraApi(fetchImpl, 'https://exec', 't', 'updateField', {}, { write: true, sleep: noSleep }),
    (err) => {
      assert.equal(err.litejiraTransport.leg, '二');
      assert.equal(err.litejiraTransport.status, 404);
      return true;
    }
  );
  assert.equal(posts.length, 1, '寫入動作只能送出一次，否則會重複寫入');
});

test('GH-303：錯誤訊息帶齊最終網址、內容型別與回應內容', async () => {
  const fetchImpl = async (url, options) => {
    if ((options && options.method) === 'POST') return reply(302, '', REDIRECT);
    return reply(404, DRIVE_404, { 'content-type': 'text/html', __url: REDIRECT.location });
  };

  await assert.rejects(
    () => postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, { write: true, sleep: noSleep }),
    (err) => {
      assert.match(err.message, /script\.googleusercontent\.com/, '要看得出最後連到哪個主機');
      assert.match(err.message, /參數已遮蔽/, '查詢字串含臨時憑證，必須遮蔽');
      assert.match(err.message, /text\/html/, '要帶內容型別');
      assert.match(err.message, /找不到網頁/, '要帶頁面標題，這是分辨兩種失敗的關鍵');
      assert.match(err.message, /requestId/, '要帶 requestId 才對得上伺服器端紀錄');
      return true;
    }
  );
});

test('GH-303：HTML 錯誤頁只帶標題，不夾帶原始內容（守 LJ-116 的不洩 body）', async () => {
  // 登入頁把憑證藏在 sanitizeErrorBody_ 認不出的形狀裡（表單欄位 / nonce）
  const sneaky = '<!DOCTYPE html><html><head><title>登入</title>' +
    '<script nonce="ltj_secret_nonce_zzz"></script></head>' +
    '<body><input name="csrf" value="ltj_secret_csrf_zzz"></body></html>';
  const fetchImpl = async (url, options) => {
    if ((options && options.method) === 'POST') return reply(302, '', REDIRECT);
    return reply(401, sneaky, { 'content-type': 'text/html' });
  };

  await assert.rejects(
    () => postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, { write: true, sleep: noSleep }),
    (err) => {
      assert.match(err.message, /標題：登入/, '標題要留下 —— 那是診斷用的');
      assert.doesNotMatch(err.message, /ltj_secret_nonce_zzz/, 'nonce 不得外洩');
      assert.doesNotMatch(err.message, /ltj_secret_csrf_zzz/, '表單欄位值不得外洩');
      assert.doesNotMatch(err.message, /<input/, '不得夾帶原始 HTML');
      return true;
    }
  );
});

test('GH-303：第一段回 200 但夾帶 HTML 錯誤頁時，唯讀動作會重發', async () => {
  let n = 0;
  const fetchImpl = async (url, options) => {
    if ((options && options.method) === 'POST') {
      n++;
      // 第一次拿到「無權限」頁（導向鏈繞回 doGet），第二次正常導向
      return n === 1
        ? reply(200, DENIED_HTML, { 'content-type': 'text/html' })
        : reply(302, '', REDIRECT);
    }
    return reply(200, JSON_OK, { 'content-type': 'application/json' });
  };

  const envelope = await postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, { sleep: noSleep });
  assert.deepEqual(envelope, { ok: true, data: { count: 1 } });
  assert.equal(n, 2);
});

test('GH-303：業務錯誤（HTTP 200 + JSON）照舊原樣回傳，不進重試', async () => {
  let n = 0;
  const body = JSON.stringify({ ok: false, error: { code: 'AUTH_FAILED', message: 'bad token' } });
  const fetchImpl = async (url, options) => {
    n++;
    if ((options && options.method) === 'POST') return reply(302, '', REDIRECT);
    return reply(200, body, { 'content-type': 'application/json' });
  };

  const envelope = await postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, { sleep: noSleep });
  assert.equal(envelope.error.code, 'AUTH_FAILED');
  assert.equal(n, 2, '不該因為 ok:false 就重試 —— 那是業務結果不是傳輸失敗');
});

test('GH-303：沒有導向的回應（測試替身 / 直接回 JSON）維持原行為', async () => {
  const fetchImpl = async () => reply(200, JSON_OK, { 'content-type': 'application/json' });
  const envelope = await postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, { sleep: noSleep });
  assert.deepEqual(envelope, { ok: true, data: { count: 1 } });
});

test('GH-303：逾時預算用盡就停止重試', async () => {
  let n = 0;
  const fetchImpl = async (url, options) => {
    n++;
    if ((options && options.method) === 'POST') return reply(302, '', REDIRECT);
    return reply(404, DRIVE_404, { 'content-type': 'text/html' });
  };

  await assert.rejects(
    () => postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, { budgetMs: -1, sleep: noSleep })
  );
  assert.equal(n, 2, '預算已用盡：第一段一次 + 第二段一次就該收手');
});
