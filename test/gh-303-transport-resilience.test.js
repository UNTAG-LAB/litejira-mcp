const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { postLiteJiraApi } = require('../ltj-cli');

// 造一個假回應。headers 用 Map 模擬 fetch 的 Headers 介面（真實的 get 不分大小寫，
// 故這裡也統一小寫化，避免 fixture 寫成 'Location' 就靜默拿到 null）。
function reply(status, body, headers) {
  const entries = Object.entries(headers || {}).map(([k, v]) => [String(k).toLowerCase(), v]);
  const map = new Map(entries);
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
const READ = { write: false, sleep: noSleep };
const WRITE = { write: true, sleep: noSleep };

test('GH-303：第二段 404 後重取成功，指令碼不會被再次執行', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: (options && options.method) || 'GET' });
    if ((options && options.method) === 'POST') return reply(302, '', REDIRECT);
    return calls.filter((c) => c.method === 'GET').length === 1
      ? reply(404, DRIVE_404, { 'content-type': 'text/html' })
      : reply(200, JSON_OK, { 'content-type': 'application/json' });
  };

  const envelope = await postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, READ);

  assert.deepEqual(envelope, { ok: true, data: { count: 1 } });
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1, '第一段只能打一次');
  assert.equal(calls.filter((c) => c.method === 'GET').length, 2, '第二段重取一次');
});

// ── 寫入安全 ──────────────────────────────────────────────

test('GH-303：漏傳旗標時預設為寫入 —— 第一段只送一次', async () => {
  // scripts/litejira-worker.js 與 scripts/litejira-api-smoke.js 都沒傳 options，
  // 而 worker 處理的全是寫入動作。預設若偏向「可重發」，一則留言最壞會寫 3 次
  // （再疊 worker 自己的 job 重試就是 9 次）。這條守的就是那個預設值。
  const posts = [];
  const fetchImpl = async (url, options) => {
    if ((options && options.method) === 'POST') { posts.push(url); return reply(302, '', REDIRECT); }
    return reply(404, DRIVE_404, { 'content-type': 'text/html' });
  };

  await assert.rejects(() => postLiteJiraApi(fetchImpl, 'https://exec', 't', 'addComment', {}, { sleep: noSleep }));
  assert.equal(posts.length, 1, '沒宣告 write: false 就必須當成寫入，只送一次');
});

test('GH-303：寫入動作在第二段失敗後絕不重發第一段', async () => {
  const posts = [];
  const fetchImpl = async (url, options) => {
    if ((options && options.method) === 'POST') { posts.push(url); return reply(302, '', REDIRECT); }
    return reply(404, DRIVE_404, { 'content-type': 'text/html' });
  };

  await assert.rejects(
    () => postLiteJiraApi(fetchImpl, 'https://exec', 't', 'updateField', {}, WRITE),
    (err) => {
      assert.equal(err.litejiraTransport.leg, '二');
      assert.equal(err.litejiraTransport.status, 404);
      return true;
    }
  );
  assert.equal(posts.length, 1, '寫入動作只能送出一次，否則會重複寫入');
});

test('GH-303：寫入在第一段拋例外 / 第一段回 HTML 時，一樣不重發', async () => {
  for (const mode of ['throw', 'html']) {
    const posts = [];
    const fetchImpl = async (url, options) => {
      posts.push(url);
      if (mode === 'throw') throw new Error('connection reset');
      return reply(200, DENIED_HTML, { 'content-type': 'text/html' });
    };
    await assert.rejects(() => postLiteJiraApi(fetchImpl, 'https://exec', 't', 'updateField', {}, WRITE));
    assert.equal(posts.length, 1, mode + '：寫入第一段仍只能送一次');
  }
});

test('GH-303：寫入在第二段失敗時，錯誤要明講「寫入可能已生效」', async () => {
  const fetchImpl = async (url, options) =>
    ((options && options.method) === 'POST')
      ? reply(302, '', REDIRECT)
      : reply(404, DRIVE_404, { 'content-type': 'text/html' });

  await assert.rejects(
    () => postLiteJiraApi(fetchImpl, 'https://exec', 't', 'addComment', {}, WRITE),
    (err) => {
      assert.match(err.message, /寫入很可能已生效/, '上層會自動重試，必須擋在訊息裡');
      assert.equal(err.litejiraTransport.writeMayHaveApplied, true);
      return true;
    }
  );
});

test('GH-303：寫入在第一段就失敗時，不得誤報「可能已生效」', async () => {
  const fetchImpl = async () => reply(500, '<html><title>Server Error</title></html>', { 'content-type': 'text/html' });
  await assert.rejects(
    () => postLiteJiraApi(fetchImpl, 'https://exec', 't', 'addComment', {}, WRITE),
    (err) => {
      assert.equal(err.litejiraTransport.writeMayHaveApplied, false, '第一段失敗＝指令碼沒跑完，不該嚇人');
      assert.doesNotMatch(err.message, /寫入很可能已生效/);
      return true;
    }
  );
});

// ── 診斷資訊不得洩漏憑證 ──────────────────────────────────

test('GH-303：錯誤訊息帶齊最終網址、內容型別與頁面標題', async () => {
  const fetchImpl = async (url, options) =>
    ((options && options.method) === 'POST')
      ? reply(302, '', REDIRECT)
      : reply(404, DRIVE_404, { 'content-type': 'text/html', __url: REDIRECT.location });

  await assert.rejects(
    () => postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, WRITE),
    (err) => {
      assert.match(err.message, /script\.googleusercontent\.com/, '要看得出最後連到哪個主機');
      assert.match(err.message, /已遮蔽/, '查詢字串含臨時憑證，必須遮蔽');
      assert.doesNotMatch(err.message, /key=abc/, '查詢字串不得外洩');
      assert.match(err.message, /text\/html/, '要帶內容型別');
      assert.match(err.message, /找不到網頁/, '要帶頁面標題，這是分辨兩種失敗的關鍵');
      assert.match(err.message, /requestId/, '要帶 requestId 才對得上伺服器端紀錄');
      return true;
    }
  );
});

test('GH-303：非 JSON 回應一律只帶標題 —— 不論對方宣告什麼內容型別', async () => {
  // 審查發現的破口：原本用 content-type 或「以 <!doctype 起頭」判斷是不是 HTML，
  // 這兩個都由回應方決定。對方只要宣告 application/xml、內容不以 doctype 起頭，
  // 就能讓夾帶憑證的頁面走進「倒 200 字原文」那條路。改成以「能否解析成 JSON」判準。
  const sneaky = '<?xml version="1.0"?><html><head><title>登入</title></head><body>' +
    '<input name="csrf" value="ltj_secret_csrf_zzz">' +
    '<script nonce="ltj_secret_nonce_zzz"></script></body></html>';

  for (const ctype of ['application/xml', 'text/plain', 'application/octet-stream', '']) {
    const fetchImpl = async (url, options) =>
      ((options && options.method) === 'POST')
        ? reply(302, '', REDIRECT)
        : reply(401, sneaky, { 'content-type': ctype });

    await assert.rejects(
      () => postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, WRITE),
      (err) => {
        assert.match(err.message, /標題：登入/, ctype + '：標題要留下');
        assert.doesNotMatch(err.message, /ltj_secret_csrf_zzz/, ctype + '：表單欄位值不得外洩');
        assert.doesNotMatch(err.message, /ltj_secret_nonce_zzz/, ctype + '：nonce 不得外洩');
        assert.doesNotMatch(err.message, /<input/, ctype + '：不得夾帶原始內容');
        return true;
      }
    );
  }
});

test('GH-303：標題內回顯的網址要遮蔽，屬性含 > 不得繞過取值', async () => {
  const cases = [
    {
      name: '標題回顯被擋網址',
      body: '<html><head><title>Access Denied: https://script.googleusercontent.com/echo?user_content_key=SECRETKEY_zzz</title></head></html>',
      leaked: 'SECRETKEY_zzz'
    },
    {
      name: '屬性值含 >',
      body: '<html><head><title data-x="a>b">ltj_pat_afterattr_zzz</title></head></html>',
      leaked: 'ltj_pat_afterattr_zzz'
    }
  ];

  for (const c of cases) {
    const fetchImpl = async (url, options) =>
      ((options && options.method) === 'POST') ? reply(302, '', REDIRECT) : reply(404, c.body, { 'content-type': 'text/html' });

    await assert.rejects(
      () => postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, WRITE),
      (err) => {
        assert.doesNotMatch(err.message, new RegExp(c.leaked), c.name + '：不得外洩');
        return true;
      }
    );
  }
});

test('GH-303：最終網址的片段與帳密都要遮蔽', async () => {
  const cases = [
    { url: 'https://accounts.google.com/o/approval#access_token=ya29.SECRET_zzz', leaked: 'ya29.SECRET_zzz' },
    { url: 'https://svc:ltj_pat_INURL_zzz@proxy.corp/echo', leaked: 'ltj_pat_INURL_zzz' }
  ];

  for (const c of cases) {
    const fetchImpl = async (url, options) =>
      ((options && options.method) === 'POST')
        ? reply(302, '', { location: c.url })
        : reply(404, DRIVE_404, { 'content-type': 'text/html', __url: c.url });

    await assert.rejects(
      () => postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, WRITE),
      (err) => {
        assert.doesNotMatch(err.message, new RegExp(c.leaked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), c.url + ' 不得外洩');
        assert.doesNotMatch(JSON.stringify(err.litejiraTransport), new RegExp(c.leaked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          'litejiraTransport 也不得留原始網址 —— 註解邀請上層記錄它');
        return true;
      }
    );
  }
});

test('GH-303：連線層例外訊息要過脫敏與截短', async () => {
  const fetchImpl = async () => { throw new Error('boom ltj_pat_INEXC_zzz ' + 'x'.repeat(500)); };
  await assert.rejects(
    () => postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, WRITE),
    (err) => {
      assert.doesNotMatch(err.message, /ltj_pat_INEXC_zzz/, '例外訊息裡的權杖也要遮罩');
      assert.match(err.message, /截短/, '例外訊息一樣要截短');
      return true;
    }
  );
});

// ── 導向處理 ──────────────────────────────────────────────

test('GH-303：相對 Location 要對基準網址解析，不得原樣餵給 fetch', async () => {
  // 不解析的話 undici 會拋「Failed to parse URL from /macros/echo?user_content_key=…」，
  // 把等同臨時憑證的查詢字串原樣寫進例外訊息，繞過所有遮蔽。
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(String(url));
    if ((options && options.method) === 'POST') {
      return reply(302, '', { location: '/macros/echo?user_content_key=TEMPCRED_zzz' });
    }
    return reply(200, JSON_OK, { 'content-type': 'application/json' });
  };

  const envelope = await postLiteJiraApi(fetchImpl, 'https://script.google.com/macros/s/AK/exec', 't', 'searchTickets', {}, READ);
  assert.deepEqual(envelope, { ok: true, data: { count: 1 } });
  assert.equal(seen[1], 'https://script.google.com/macros/echo?user_content_key=TEMPCRED_zzz', '相對路徑要解析成絕對網址');
});

test('GH-303：同源的 307/308 要用原方法續送（舊版靠自動續跳，改手動後必須自己補）', async () => {
  for (const status of [307, 308]) {
    const seen = [];
    const fetchImpl = async (url, options) => {
      const method = (options && options.method) || 'GET';
      seen.push(method + ' ' + url);
      if (seen.length === 1) return reply(status, '', { location: '/v2/exec' });
      if (method === 'POST') return reply(302, '', REDIRECT);
      return reply(200, JSON_OK, { 'content-type': 'application/json' });
    };

    const envelope = await postLiteJiraApi(fetchImpl, 'https://api.example/exec', 't', 'searchTickets', {}, READ);
    assert.deepEqual(envelope, { ok: true, data: { count: 1 } }, status + ' 應能完成');
    assert.equal(seen[1], 'POST https://api.example/v2/exec', status + ' 必須維持 POST 且解析相對路徑');
  }
});

test('GH-303：跨主機的 307/308 不得續送 —— 請求內容含存取權杖', async () => {
  for (const status of [307, 308]) {
    const seen = [];
    const fetchImpl = async (url, options) => {
      seen.push(String(url));
      return reply(status, '', { location: 'https://evil.example/collect' });
    };

    await assert.rejects(
      () => postLiteJiraApi(fetchImpl, 'https://api.example/exec', 'ltj_pat_SECRET_zzz', 'searchTickets', {}, READ),
      (err) => {
        assert.doesNotMatch(err.message, /ltj_pat_SECRET_zzz/, '權杖不得出現在訊息');
        return true;
      }
    );
    assert.equal(seen.length, 1, status + '：不得把帶權杖的請求送去第三方主機');
    assert.ok(!seen.some((u) => u.includes('evil.example')), status + '：完全沒碰過第三方主機');
  }
});

test('GH-303：連續 307 不會無限續跳', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return reply(307, '', { location: '/again' }); };
  await assert.rejects(() => postLiteJiraApi(fetchImpl, 'https://api.example/exec', 't', 'searchTickets', {}, READ));
  assert.equal(n, 2, '只續跳一次：第二個 307 就收手');
});

test('GH-303：畸形的 Location 不得被拿去 fetch', async () => {
  // 解析失敗時若退回原字串再 fetch，undici 會把整串（含查詢字串）寫進例外訊息
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(String(url));
    return reply(302, '', { location: 'https://[?user_content_key=SECRET_zzz' });
  };

  await assert.rejects(
    () => postLiteJiraApi(fetchImpl, 'https://api.example/exec', 't', 'searchTickets', {}, READ),
    (err) => {
      assert.doesNotMatch(err.message, /SECRET_zzz/, '畸形網址的查詢字串不得外洩');
      assert.match(err.message, /無法解析為合法網址/);
      return true;
    }
  );
  assert.equal(seen.length, 1, '只打過第一段，沒拿畸形網址去 fetch');
});

test('GH-303：寫入可能已生效時掛 transient=false，擋住呼叫端的自動重試', async () => {
  // scripts/litejira-worker.js 的 classifyWorkerError_ 把沒有 code 的錯誤判為可重試，
  // 會把同一則留言重送 3 次。這個旗標是唯一能擋住它的接點。
  const cases = [
    { name: '第二段失敗', impl: async (url, o) => ((o && o.method) === 'POST' ? reply(302, '', REDIRECT) : reply(404, DRIVE_404, { 'content-type': 'text/html' })) },
    { name: '連線中斷', impl: async () => { throw new Error('socket hang up'); } }
  ];

  for (const c of cases) {
    await assert.rejects(
      () => postLiteJiraApi(c.impl, 'https://exec', 't', 'addComment', {}, WRITE),
      (err) => {
        assert.equal(err.transient, false, c.name + '：必須標成不可重試');
        assert.equal(err.litejiraTransport.writeMayHaveApplied, true);
        return true;
      }
    );
  }

  // 唯讀動作不該被標成不可重試 —— 呼叫端重讀沒有副作用
  const readImpl = async (url, o) => ((o && o.method) === 'POST' ? reply(302, '', REDIRECT) : reply(404, DRIVE_404, { 'content-type': 'text/html' }));
  await assert.rejects(
    () => postLiteJiraApi(readImpl, 'https://exec', 't', 'searchTickets', {}, READ),
    (err) => {
      assert.notEqual(err.transient, false, '唯讀失敗仍可重試');
      return true;
    }
  );
});

// ── 逾時 ──────────────────────────────────────────────────

test('GH-303：逾時落在「標頭已到、內容未讀完」時仍要重取並留下診斷', async () => {
  // 這條路是本次新加的 8 秒逾時自己製造的：中止例外從 text() 拋出。
  // text() 若在 try 外面，例外會整個逃逸 —— 不重取、也沒有任何診斷。
  let gets = 0;
  const fetchImpl = async (url, options) => {
    if ((options && options.method) === 'POST') return reply(302, '', REDIRECT);
    gets++;
    if (gets === 1) {
      return {
        status: 200, ok: true, url: REDIRECT.location,
        headers: { get: () => 'application/json' },
        text: async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }
      };
    }
    return reply(200, JSON_OK, { 'content-type': 'application/json' });
  };

  const envelope = await postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, READ);
  assert.deepEqual(envelope, { ok: true, data: { count: 1 } });
  assert.equal(gets, 2, '讀內容階段的逾時必須觸發重取');
});

test('GH-303：讀內容階段逾時且重取全失敗時，錯誤仍帶得出診斷', async () => {
  const fetchImpl = async (url, options) => {
    if ((options && options.method) === 'POST') return reply(302, '', REDIRECT);
    return {
      status: 200, ok: true, url: REDIRECT.location,
      headers: { get: () => 'application/json' },
      text: async () => { throw new Error('The operation was aborted due to timeout'); }
    };
  };

  await assert.rejects(
    () => postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, WRITE),
    (err) => {
      assert.ok(err.litejiraTransport, '必須帶得出結構化診斷，不能讓中止例外裸奔');
      assert.equal(err.litejiraTransport.leg, '二');
      assert.match(err.message, /requestId/);
      return true;
    }
  );
});

// ── 相容性 ────────────────────────────────────────────────

test('GH-303：業務錯誤（HTTP 200 + JSON）照舊原樣回傳，不進重試', async () => {
  let n = 0;
  const body = JSON.stringify({ ok: false, error: { code: 'AUTH_FAILED', message: 'bad token' } });
  const fetchImpl = async (url, options) => {
    n++;
    if ((options && options.method) === 'POST') return reply(302, '', REDIRECT);
    return reply(200, body, { 'content-type': 'application/json' });
  };

  const envelope = await postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, READ);
  assert.equal(envelope.error.code, 'AUTH_FAILED');
  assert.equal(n, 2, '不該因為 ok:false 就重試 —— 那是業務結果不是傳輸失敗');
});

test('GH-303：沒有導向的回應（測試替身 / 直接回 JSON）維持原行為', async () => {
  const fetchImpl = async () => reply(200, JSON_OK, { 'content-type': 'application/json' });
  const envelope = await postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, READ);
  assert.deepEqual(envelope, { ok: true, data: { count: 1 } });
});

test('GH-303：第一段對誰都只送一次 —— 唯讀動作也不重發', async () => {
  // 量測結論（2026-08-12 正式環境交錯對照）：重發第一段對失敗率零貢獻
  // （25% vs 25%），只換來 17 秒中位數延遲。砍掉後安全性也不再依賴呼叫端傳旗標。
  for (const opts of [READ, WRITE, { sleep: noSleep }]) {
    let posts = 0;
    const fetchImpl = async (url, options) => {
      if ((options && options.method) === 'POST') {
        posts++;
        return reply(200, DENIED_HTML, { 'content-type': 'text/html' });
      }
      return reply(200, JSON_OK, { 'content-type': 'application/json' });
    };

    await assert.rejects(
      () => postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, opts),
      (err) => {
        assert.match(err.message, /標題：LiteJira — 無權限/, '要留下可診斷的標題');
        return true;
      }
    );
    assert.equal(posts, 1, JSON.stringify(Object.keys(opts)) + '：第一段只能送一次');
  }
});

test('GH-303：逾時預算用盡就停止重試', async () => {
  let n = 0;
  const fetchImpl = async (url, options) => {
    n++;
    if ((options && options.method) === 'POST') return reply(302, '', REDIRECT);
    return reply(404, DRIVE_404, { 'content-type': 'text/html' });
  };

  await assert.rejects(
    () => postLiteJiraApi(fetchImpl, 'https://exec', 't', 'searchTickets', {}, { write: false, budgetMs: -1, sleep: noSleep })
  );
  assert.equal(n, 2, '預算已用盡：第一段一次 + 第二段一次就該收手');
});

// ── 真實 fetch 的端對端（守住測試替身看不見的性質）──────────

test('GH-303：真實 fetch —— 只重取第二段，第一段的 POST 不重送', async () => {
  // 測試替身不管 options.redirect，所以刪掉 redirect:'manual' 也不會紅。
  // 這條用真的 HTTP 伺服器數 POST 次數，把那個性質釘住。
  let posts = 0;
  let gets = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      posts++;
      req.resume();
      res.writeHead(302, { Location: '/echo?user_content_key=TEMPCRED_zzz' });
      return res.end();
    }
    gets++;
    if (gets === 1) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      return res.end(DRIVE_404);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON_OK);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = 'http://127.0.0.1:' + server.address().port + '/exec';

  try {
    const envelope = await postLiteJiraApi(globalThis.fetch, base, 't', 'addComment', {}, { write: true, sleep: noSleep });
    assert.deepEqual(envelope, { ok: true, data: { count: 1 } });
    assert.equal(posts, 1, '寫入動作的 POST 只能送一次');
    assert.equal(gets, 2, '第二段要重取一次');
  } finally {
    server.close();
  }
});

test('GH-303：真實 fetch —— 相對 Location 不得把臨時憑證洩進例外訊息', async () => {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      req.resume();
      res.writeHead(302, { Location: '/echo?user_content_key=TEMPCRED_LEAK_zzz' });
      return res.end();
    }
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end(DRIVE_404);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = 'http://127.0.0.1:' + server.address().port + '/exec';

  try {
    await assert.rejects(
      () => postLiteJiraApi(globalThis.fetch, base, 't', 'addComment', {}, { write: true, sleep: noSleep }),
      (err) => {
        assert.doesNotMatch(err.message, /TEMPCRED_LEAK_zzz/, '臨時憑證不得出現在錯誤訊息');
        assert.doesNotMatch(JSON.stringify(err.litejiraTransport), /TEMPCRED_LEAK_zzz/);
        assert.match(err.message, /找不到網頁/, '仍要留下可診斷的標題');
        return true;
      }
    );
  } finally {
    server.close();
  }
});
