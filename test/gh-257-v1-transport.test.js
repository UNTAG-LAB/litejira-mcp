'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  API_ERROR_STATUS,
  DEFAULT_TIMEOUT_MS,
  LiteJiraApiError,
  LiteJiraTransportError,
  buildRequest,
  callV1,
  normalizeBaseUrl
} = require('../litejira-v1-transport');
const { parseCommand, runCli } = require('../ltj-cli');

const BASE = 'https://litejira.example.com';
const TOKEN = 'pat_abcdefghijklmnop';
const KEY = 'abcdefghijklmnop1234';
const UUID = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';
const UUID2 = '8a7b6c5d-4e3f-4a2b-9c8d-7e6f5a4b3c2d';

// mock fetch：payload 若是字串就原樣當 body，否則 JSON 序列化。
function jsonResponse(status, payload, calls) {
  return function (url, init) {
    if (calls) calls.push({ url: url, init: init });
    return Promise.resolve({
      status: status,
      text: function () { return Promise.resolve(typeof payload === 'string' ? payload : JSON.stringify(payload)); }
    });
  };
}

function collectIo() {
  const logs = [];
  const errors = [];
  return {
    logs: logs,
    errors: errors,
    io: { log: function (l) { logs.push(l); }, error: function (l) { errors.push(l); } }
  };
}

function env() {
  return { LTJ_API_URL: BASE, LTJ_API_TOKEN: TOKEN };
}

// ── 映射：真正的 method / path / query ──

test('searchTickets 映射到 GET /api/v1/tickets，帶 Bearer 且 GET 不掛 Idempotency-Key', function () {
  const req = buildRequest({
    baseUrl: BASE,
    token: TOKEN,
    action: 'searchTickets',
    params: { project: 'LTJ', limit: 50, cursor: 'Y3Vyc29y' },
    idempotencyKey: KEY
  });
  assert.strictEqual(req.method, 'GET');
  assert.strictEqual(req.url, BASE + '/api/v1/tickets?project=LTJ&limit=50&cursor=Y3Vyc29y');
  assert.strictEqual(req.headers.Authorization, 'Bearer ' + TOKEN);
  assert.strictEqual(req.headers.Accept, 'application/json');
  assert.strictEqual(req.headers['Idempotency-Key'], undefined);
  assert.strictEqual(req.body, undefined);
});

test('searchTickets 多值條件用重複 query，不做逗號串接', function () {
  const req = buildRequest({
    baseUrl: BASE,
    token: TOKEN,
    action: 'searchTickets',
    params: { status: ['open', 'doing'], type: ['bug'], sort: 'updatedAt', order: 'desc' }
  });
  assert.strictEqual(req.url,
    BASE + '/api/v1/tickets?status=open&status=doing&type=bug&sort=updatedAt&order=desc');
});

test('searchTickets 的 sort / order 只收契約值域，limit 只收正整數', function () {
  [{ sort: 'title' }, { order: 'ASC' }, { limit: 0 }, { limit: 1.5 }, { limit: '-3' }].forEach(function (params) {
    assert.throws(function () {
      buildRequest({ baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: params });
    }, function (err) {
      return err instanceof LiteJiraTransportError && err.code === 'invalid_argument';
    }, JSON.stringify(params));
  });
});

test('讀取路由：detail / comments / activity 走各自的路徑端點，不需要 project', function () {
  assert.strictEqual(
    buildRequest({ baseUrl: BASE, token: TOKEN, action: 'getTicket', params: { ticket: 'BUG-481' } }).url,
    BASE + '/api/v1/tickets/BUG-481');
  assert.strictEqual(
    buildRequest({ baseUrl: BASE, token: TOKEN, action: 'getTicket', params: { ticket: UUID } }).url,
    BASE + '/api/v1/tickets/' + UUID);
  assert.strictEqual(
    buildRequest({ baseUrl: BASE, token: TOKEN, action: 'getTicket', params: { ticket: '481' } }).url,
    BASE + '/api/v1/tickets/481');
  assert.strictEqual(
    buildRequest({
      baseUrl: BASE, token: TOKEN, action: 'listComments',
      params: { ticket: 'BUG-481', limit: 20, order: 'asc' }
    }).url,
    BASE + '/api/v1/tickets/BUG-481/comments?limit=20&order=asc');
  assert.strictEqual(
    buildRequest({
      baseUrl: BASE, token: TOKEN, action: 'getActivityLog',
      params: { ticket: 'BUG-481', kind: 'system' }
    }).url,
    BASE + '/api/v1/tickets/BUG-481/activity?kind=system');
});

test('activity 的舊 includeComments / includeSystemEvents 明確拒絕並指路 kind，不靜默丟棄', function () {
  ['includeComments', 'includeSystemEvents'].forEach(function (key) {
    const params = { ticket: 'BUG-481' };
    params[key] = 'true';
    assert.throws(function () {
      buildRequest({ baseUrl: BASE, token: TOKEN, action: 'getActivityLog', params: params });
    }, function (err) {
      return err instanceof LiteJiraTransportError && err.code === 'invalid_argument' && /kind/.test(err.message);
    }, key);
  });
  assert.throws(function () {
    buildRequest({ baseUrl: BASE, token: TOKEN, action: 'getActivityLog', params: { ticket: 'x', kind: 'all' } });
  }, function (err) { return err.code === 'invalid_argument'; });
});

test('linkTickets 是 PUT /tickets/{childId}/parent，parentId 走 body 且可為 null', function () {
  const req = buildRequest({
    baseUrl: BASE, token: TOKEN, action: 'linkTickets', idempotencyKey: KEY,
    params: { childId: 'BUG-481', parentId: UUID, expectedUpdatedAt: '2026-09-11T03:04:05.123456Z' }
  });
  assert.strictEqual(req.method, 'PUT');
  assert.strictEqual(req.url, BASE + '/api/v1/tickets/BUG-481/parent');
  assert.deepStrictEqual(JSON.parse(req.body), {
    parentId: UUID, expectedUpdatedAt: '2026-09-11T03:04:05.123456Z'
  });
  assert.strictEqual(req.headers['Idempotency-Key'], KEY);

  const unlink = buildRequest({
    baseUrl: BASE, token: TOKEN, action: 'linkTickets', idempotencyKey: KEY,
    params: { childId: '481', parentId: null }
  });
  assert.deepStrictEqual(JSON.parse(unlink.body), { parentId: null });

  assert.throws(function () {
    buildRequest({
      baseUrl: BASE, token: TOKEN, action: 'linkTickets', idempotencyKey: KEY,
      params: { childId: 'BUG-481', parentId: 'EPIC-9' }
    });
  }, function (err) { return err.code === 'invalid_argument' && /UUID/.test(err.message); });
});

test('addComment 是 POST /tickets/{ticketId}/comments，body 只收 body / mentions', function () {
  const req = buildRequest({
    baseUrl: BASE, token: TOKEN, action: 'addComment', idempotencyKey: KEY,
    params: { ticketId: 'BUG-481', body: '已修正', mentions: [UUID, UUID2] }
  });
  assert.strictEqual(req.method, 'POST');
  assert.strictEqual(req.url, BASE + '/api/v1/tickets/BUG-481/comments');
  assert.deepStrictEqual(JSON.parse(req.body), { body: '已修正', mentions: [UUID, UUID2] });

  // 舊的流轉 / 樂觀鎖旗標必須明確拒絕，不可靜默丟掉
  [{ transition: { toStatus: 'done' } }, { toStatus: 'done' }, { expectedUpdatedAt: '2026-09-11T03:04:05.123456Z' }]
    .forEach(function (extra) {
      const params = Object.assign({ ticketId: 'BUG-481', body: 'x' }, extra);
      assert.throws(function () {
        buildRequest({ baseUrl: BASE, token: TOKEN, action: 'addComment', idempotencyKey: KEY, params: params });
      }, function (err) {
        return err instanceof LiteJiraTransportError && err.code === 'invalid_argument';
      }, JSON.stringify(extra));
    });

  assert.throws(function () {
    buildRequest({
      baseUrl: BASE, token: TOKEN, action: 'addComment', idempotencyKey: KEY,
      params: { ticketId: 'BUG-481', body: 'x', mentions: ['小明'] }
    });
  }, function (err) { return err.code === 'invalid_argument'; });

  assert.throws(function () {
    buildRequest({
      baseUrl: BASE, token: TOKEN, action: 'addComment', idempotencyKey: KEY,
      params: { ticketId: 'BUG-481' }
    });
  }, function (err) { return err.code === 'invalid_argument' && /body/.test(err.message); });
});

test('replyFeedback 在 v1 已被取代，本機拒絕並指路 addComment', function () {
  assert.throws(function () {
    buildRequest({ baseUrl: BASE, token: TOKEN, action: 'replyFeedback', idempotencyKey: KEY, params: {} });
  }, function (err) {
    return err instanceof LiteJiraTransportError && err.code === 'replaced_action' && /addComment/.test(err.message);
  });
});

test('attachLink 是 POST /tickets/{ticketId}/attachments，只收 url / name 且限 http(s)', function () {
  const req = buildRequest({
    baseUrl: BASE, token: TOKEN, action: 'attachLink', idempotencyKey: KEY,
    params: { ticketId: 'BUG-481', url: 'https://example.com/a.png', name: '截圖' }
  });
  assert.strictEqual(req.method, 'POST');
  assert.strictEqual(req.url, BASE + '/api/v1/tickets/BUG-481/attachments');
  assert.deepStrictEqual(JSON.parse(req.body), { url: 'https://example.com/a.png', name: '截圖' });

  assert.throws(function () {
    buildRequest({
      baseUrl: BASE, token: TOKEN, action: 'attachLink', idempotencyKey: KEY,
      params: { ticketId: 'BUG-481', url: 'https://example.com/a.png', kind: 'image' }
    });
  }, function (err) { return err.code === 'invalid_argument' && /kind/.test(err.message); });

  ['file:///etc/passwd', 'javascript:alert(1)', 'not a url'].forEach(function (bad) {
    assert.throws(function () {
      buildRequest({
        baseUrl: BASE, token: TOKEN, action: 'attachLink', idempotencyKey: KEY,
        params: { ticketId: 'BUG-481', url: bad }
      });
    }, function (err) { return err.code === 'invalid_argument'; }, bad);
  });
});

test('寫入路由缺 Idempotency-Key 或格式錯誤都在本機擋下', function () {
  assert.throws(function () {
    buildRequest({
      baseUrl: BASE, token: TOKEN, action: 'addComment',
      params: { ticketId: 'BUG-481', body: 'x' }
    });
  }, function (err) { return err.code === 'idempotency_key_required'; });

  assert.throws(function () {
    buildRequest({
      baseUrl: BASE, token: TOKEN, action: 'addComment', idempotencyKey: 'short',
      params: { ticketId: 'BUG-481', body: 'x' }
    });
  }, function (err) { return err.code === 'invalid_argument'; });
});

test('base URL 已含 /api/v1 或帶尾斜線都不會重複串接', function () {
  assert.strictEqual(normalizeBaseUrl(BASE), BASE + '/api/v1');
  assert.strictEqual(normalizeBaseUrl(BASE + '/'), BASE + '/api/v1');
  assert.strictEqual(normalizeBaseUrl(BASE + '/api/v1'), BASE + '/api/v1');
  assert.strictEqual(normalizeBaseUrl(BASE + '/api/v1/'), BASE + '/api/v1');
});

test('成員條件只收 UUID，顯示名被本機擋下並指路 assigneeId', function () {
  const ok = buildRequest({ baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: { assigneeId: UUID } });
  assert.strictEqual(ok.url, BASE + '/api/v1/tickets?assigneeId=' + UUID);

  assert.throws(function () {
    buildRequest({ baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: { assignee: '小明' } });
  }, function (err) {
    return err instanceof LiteJiraTransportError && err.code === 'invalid_argument' && /assigneeId/.test(err.message);
  });

  assert.throws(function () {
    buildRequest({ baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: { assigneeId: 'BUG-481' } });
  }, function (err) {
    return err instanceof LiteJiraTransportError && err.code === 'invalid_argument';
  });

  // parentId 也是 UUID，不收工單 key
  assert.throws(function () {
    buildRequest({ baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: { parentId: 'EPIC-9' } });
  }, function (err) { return err.code === 'invalid_argument'; });
});

test('契約未確認的 query 參數本機拒絕，不打出不存在的查詢', function () {
  assert.throws(function () {
    buildRequest({ baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: { labels: 'crash' } });
  }, function (err) {
    return err instanceof LiteJiraTransportError && err.code === 'invalid_argument' && /尚未在 v1 契約中確認/.test(err.message);
  });
});

test('未知 action 本機拒絕，且尚未納入的 action 分開報 unmapped_action', async function () {
  let called = 0;
  const fetchImpl = function () {
    called += 1;
    return Promise.resolve({ status: 200, text: function () { return Promise.resolve('{"data":{}}'); } });
  };

  await assert.rejects(
    callV1({ fetch: fetchImpl, baseUrl: BASE, token: TOKEN, action: 'noSuchAction', params: {} }),
    function (err) { return err instanceof LiteJiraTransportError && err.code === 'unknown_action'; }
  );
  await assert.rejects(
    callV1({ fetch: fetchImpl, baseUrl: BASE, token: TOKEN, action: 'transitionTicket', params: {} }),
    function (err) { return err instanceof LiteJiraTransportError && err.code === 'unmapped_action'; }
  );
  assert.strictEqual(called, 0, '本機拒絕不得送出任何請求');
});

// ── URL 合法性 ──

test('http 只放行明確 loopback，其餘協定 / 外站 http / 帶帳密一律拒絕', function () {
  assert.strictEqual(normalizeBaseUrl('http://localhost:8787'), 'http://localhost:8787/api/v1');
  assert.strictEqual(normalizeBaseUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787/api/v1');
  assert.strictEqual(normalizeBaseUrl('http://[::1]:8787'), 'http://[::1]:8787/api/v1');

  ['http://litejira.example.com', 'ftp://litejira.example.com', 'file:///tmp/x', 'not-a-url']
    .forEach(function (bad) {
      assert.throws(function () { normalizeBaseUrl(bad); }, function (err) {
        return err instanceof LiteJiraTransportError && err.code === 'invalid_base_url';
      }, bad);
    });

  assert.throws(function () { normalizeBaseUrl('https://user:pw@litejira.example.com'); }, function (err) {
    return err instanceof LiteJiraTransportError && err.code === 'invalid_base_url';
  });
});

// ── 回應信封 ──

test('2xx 只接受 { data } 信封，並且只拆一層（不會出現 data.data）', async function () {
  const data = { items: [{ id: 'u-1', key: 'BUG-481', title: 't', assignee: null }], nextCursor: null };
  const result = await callV1({
    fetch: jsonResponse(200, { data: data }), baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: {}
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(result.data, data);
  assert.strictEqual(result.data.data, undefined);
});

test('2xx 缺 data / null / 空 body / HTML 一律 invalid_response，不無條件接受', async function () {
  const bad = [
    [200, { items: [] }],
    [200, 'null'],
    [200, ''],
    [200, '<html>ok</html>'],
    [200, '[1,2,3]'],
    [201, { ok: true }]
  ];
  for (const [status, payload] of bad) {
    await assert.rejects(
      callV1({ fetch: jsonResponse(status, payload), baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: {} }),
      function (err) {
        return err instanceof LiteJiraTransportError && err.code === 'invalid_response';
      },
      String(status) + ' ' + JSON.stringify(payload)
    );
  }
});

test('POST 回 201 或 200 都拆成 { data: attachment }', async function () {
  const attachment = { id: UUID, url: 'https://example.com/a.png', name: '截圖' };
  for (const status of [200, 201]) {
    const result = await callV1({
      fetch: jsonResponse(status, { data: attachment }),
      baseUrl: BASE, token: TOKEN, action: 'attachLink', idempotencyKey: KEY,
      params: { ticketId: 'BUG-481', url: 'https://example.com/a.png', name: '截圖' }
    });
    assert.strictEqual(result.status, status);
    assert.deepStrictEqual(result.data, attachment);
  }
});

// ── 錯誤狀態 / envelope ──

test('錯誤狀態原樣保存 error.code / message / details，不做狀態碼反推', async function () {
  const payload = {
    error: {
      code: 'version_conflict',
      message: '工單已被他人更新',
      details: { currentUpdatedAt: '2026-09-11T03:04:05.123456Z' }
    }
  };
  await assert.rejects(
    callV1({ fetch: jsonResponse(409, payload), baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: {} }),
    function (err) {
      return err instanceof LiteJiraApiError &&
        err.status === 409 &&
        err.code === 'version_conflict' &&
        err.message === '工單已被他人更新' &&
        err.details.currentUpdatedAt === '2026-09-11T03:04:05.123456Z';
    }
  );
});

test('403 三種語意各自保留 code，不被收斂成「管理限定」', async function () {
  const codes = ['membership_required', 'permission_denied', 'admin_required'];
  for (const code of codes) {
    await assert.rejects(
      callV1({
        fetch: jsonResponse(403, { error: { code: code, message: 'nope' } }),
        baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: {}
      }),
      function (err) { return err.code === code && err.status === 403; }
    );
    assert.strictEqual(API_ERROR_STATUS[code], 403);
  }
});

test('5xx 不自動重試：fetch 只被呼叫一次', async function () {
  const calls = [];
  await assert.rejects(callV1({
    fetch: jsonResponse(500, { error: { code: 'internal', message: 'boom' } }, calls),
    baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: {}
  }));
  assert.strictEqual(calls.length, 1);
});

// ── 不外洩：回應 / 網路錯誤都不轉述原文 ──

test('回應含假 token 時，錯誤訊息不外洩 body 片段（任何狀態碼皆然）', async function () {
  const secret = 'pat_supersecret_abcdef0123456789';
  const bodies = [
    '<html>Authorization: Bearer ' + secret + '</html>',
    JSON.stringify({ debug: 'token=' + secret }),
    JSON.stringify({ error: { note: secret } })
  ];
  for (const status of [200, 500]) {
    for (const body of bodies) {
      await assert.rejects(
        callV1({ fetch: jsonResponse(status, body), baseUrl: BASE, token: secret, action: 'searchTickets', params: {} }),
        function (err) {
          const dump = String(err.message) + JSON.stringify(err.details || {});
          return err instanceof LiteJiraTransportError &&
            err.code === 'invalid_response' &&
            dump.indexOf(secret) === -1 &&
            dump.indexOf('supersecret') === -1;
        },
        status + ' ' + body
      );
    }
  }
});

test('網路錯誤不轉述 err.message（原訊息可能夾帶憑證或 URL）', async function () {
  const secret = 'pat_supersecret_abcdef0123456789';
  const failing = function () {
    return Promise.reject(new Error('connect ECONNREFUSED https://x/?token=' + secret));
  };
  await assert.rejects(
    callV1({ fetch: failing, baseUrl: BASE, token: secret, action: 'searchTickets', params: {} }),
    function (err) {
      const dump = String(err.message) + JSON.stringify(err.details || {});
      return err instanceof LiteJiraTransportError &&
        err.code === 'network_error' &&
        dump.indexOf(secret) === -1 &&
        dump.indexOf('ECONNREFUSED') === -1;
    }
  );
});

// ── redirect / timeout / abort ──

test('redirect 一律不跟隨（redirect: manual + 3xx 直接拒絕），避免 Bearer 外洩', async function () {
  const calls = [];
  await assert.rejects(
    callV1({ fetch: jsonResponse(302, '', calls), baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: {} }),
    function (err) { return err instanceof LiteJiraTransportError && err.code === 'redirect_blocked'; }
  );
  assert.strictEqual(calls.length, 1, '不得跟著 redirect 再打一次');
  assert.strictEqual(calls[0].init.redirect, 'manual');
});

test('整趟逾時 20 秒為預設，且逾時會 abort 傳給 fetch 的 signal', async function () {
  assert.strictEqual(DEFAULT_TIMEOUT_MS, 20000);

  let seenInit = null;
  const hangingFetch = function (url, init) {
    seenInit = init;
    return new Promise(function (resolve, reject) {
      init.signal.addEventListener('abort', function () { reject(new Error('aborted')); });
    });
  };
  await assert.rejects(
    callV1({ fetch: hangingFetch, baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: {}, timeoutMs: 20 }),
    function (err) { return err instanceof LiteJiraTransportError && err.code === 'timeout'; }
  );
  assert.strictEqual(seenInit.signal.aborted, true);
});

test('注入的 fetch 忽略 signal、永不 settle 時，整趟 deadline 仍會收斂成 timeout', async function () {
  const deafFetch = function () { return new Promise(function () { /* 永不 settle，也不理 signal */ }); };
  await assert.rejects(
    callV1({ fetch: deafFetch, baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: {}, timeoutMs: 20 }),
    function (err) { return err instanceof LiteJiraTransportError && err.code === 'timeout'; }
  );
});

test('讀 body 忽略 signal、永不 settle 時，逾時一樣涵蓋讀取內文階段', async function () {
  const deafBodyFetch = function () {
    return Promise.resolve({
      status: 200,
      text: function () { return new Promise(function () { /* 永不 settle */ }); }
    });
  };
  await assert.rejects(
    callV1({ fetch: deafBodyFetch, baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: {}, timeoutMs: 20 }),
    function (err) { return err instanceof LiteJiraTransportError && err.code === 'timeout'; }
  );
});

test('逾時後才回來的 response 會被安全消化（不留懸空 body）', async function () {
  let cancelled = 0;
  const lateFetch = function () {
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve({
          status: 200,
          body: { cancel: function () { cancelled += 1; return Promise.resolve(); } },
          text: function () { return Promise.resolve('{"data":{}}'); }
        });
      }, 40);
    });
  };
  await assert.rejects(
    callV1({ fetch: lateFetch, baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: {}, timeoutMs: 10 }),
    function (err) { return err.code === 'timeout'; }
  );
  await new Promise(function (r) { setTimeout(r, 80); });
  assert.strictEqual(cancelled, 1, '遲到的 response body 必須被收掉');
});

test('正常完成會清掉 deadline timer（不把行程留在事件圈裡）', async function () {
  const before = process.getActiveResourcesInfo ? process.getActiveResourcesInfo().filter(isTimeout_).length : 0;
  const result = await callV1({
    fetch: jsonResponse(200, { data: { items: [] } }),
    baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: {}, timeoutMs: 60000
  });
  assert.deepStrictEqual(result.data, { items: [] });
  const after = process.getActiveResourcesInfo ? process.getActiveResourcesInfo().filter(isTimeout_).length : 0;
  assert.ok(after <= before, '成功路徑不得留下未清的 timer');
});

function isTimeout_(name) { return name === 'Timeout'; }

test('timeoutMs 只接受有限正整數', async function () {
  let called = 0;
  const fetchImpl = function () {
    called += 1;
    return Promise.resolve({ status: 200, text: function () { return Promise.resolve('{"data":{}}'); } });
  };
  for (const bad of [0, -1, 1.5, NaN, Infinity, '5000']) {
    await assert.rejects(
      callV1({ fetch: fetchImpl, baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: {}, timeoutMs: bad }),
      function (err) { return err instanceof LiteJiraTransportError && err.code === 'invalid_argument'; },
      String(bad)
    );
  }
  assert.strictEqual(called, 0);
});

test('外部 signal 已取消：一次 fetch 都不發', async function () {
  const controller = new AbortController();
  controller.abort();
  let called = 0;
  const fetchImpl = function () { called += 1; return Promise.resolve({ status: 200, text: function () { return Promise.resolve('{"data":{}}'); } }); };
  await assert.rejects(
    callV1({ fetch: fetchImpl, baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: {}, signal: controller.signal }),
    function (err) { return err instanceof LiteJiraTransportError && err.code === 'aborted'; }
  );
  assert.strictEqual(called, 0);
});

test('外部 signal 中途取消會連動內部 controller，並回 aborted（不是 network_error）', async function () {
  const controller = new AbortController();
  const hangingFetch = function (url, init) {
    return new Promise(function (resolve, reject) {
      init.signal.addEventListener('abort', function () { reject(new Error('aborted')); });
    });
  };
  const pending = callV1({
    fetch: hangingFetch, baseUrl: BASE, token: TOKEN, action: 'searchTickets', params: {}, signal: controller.signal
  });
  controller.abort();
  await assert.rejects(pending, function (err) {
    return err instanceof LiteJiraTransportError && err.code === 'aborted';
  });
});

// ── CLI 解析 ──

test('parseCommand：search 帶 project 與 UUID 條件；多值旗標收成陣列', function () {
  const search = parseCommand([
    'search', '--project', 'LTJ', '--assignee-id', UUID, '--limit', '10',
    '--status', 'open', '--status', 'doing'
  ]);
  assert.strictEqual(search.action, 'searchTickets');
  assert.strictEqual(search.params.project, 'LTJ');
  assert.strictEqual(search.params.assigneeId, UUID);
  assert.strictEqual(search.params.limit, 10);
  assert.deepStrictEqual(search.params.status, ['open', 'doing']);
});

test('parseCommand：link 的 expectedUpdatedAt 保持字串、null 解除父子關係', function () {
  const link = parseCommand([
    'link', 'BUG-481', UUID, '--yes',
    '--expected-updated-at', '2026-09-11T03:04:05.123456Z',
    '--idempotency-key', KEY
  ]);
  assert.strictEqual(link.action, 'linkTickets');
  assert.strictEqual(link.params.childId, 'BUG-481');
  assert.strictEqual(link.params.parentId, UUID);
  assert.strictEqual(link.params.expectedUpdatedAt, '2026-09-11T03:04:05.123456Z');
  assert.strictEqual(link.idempotencyKey, KEY);
  assert.strictEqual(link.write, true);

  const unlink = parseCommand(['link', 'BUG-481', 'null', '--yes', '--idempotency-key', KEY]);
  assert.strictEqual(unlink.params.parentId, null);
});

test('parseCommand：reply 是 comment 的別名，都對到 addComment', function () {
  const reply = parseCommand(['reply', 'BUG-481', '--content', '已修正', '--yes', '--idempotency-key', KEY]);
  assert.strictEqual(reply.action, 'addComment');
  assert.strictEqual(reply.params.body, '已修正');

  const comment = parseCommand(['comment', 'BUG-481', '--body', '已修正', '--mention', UUID, '--yes', '--idempotency-key', KEY]);
  assert.strictEqual(comment.action, 'addComment');
  assert.deepStrictEqual(comment.params.mentions, [UUID]);
});

// ── CLI 六指令：mock 實走 ──

test('runCli：search 送出真正的 GET /api/v1/tickets 與 Bearer，並印出拆一層後的 data', async function () {
  const calls = [];
  const out = collectIo();
  const code = await runCli(
    ['search', '--project', 'LTJ', '--status', 'open', '--status', 'doing', '--json'],
    env(), out.io,
    jsonResponse(200, { data: { items: [], nextCursor: null } }, calls)
  );
  assert.strictEqual(code, 0);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, BASE + '/api/v1/tickets?project=LTJ&status=open&status=doing');
  assert.strictEqual(calls[0].init.method, 'GET');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer ' + TOKEN);
  assert.deepStrictEqual(JSON.parse(out.logs[0]), { items: [], nextCursor: null });
});

test('runCli：show 走 GET /tickets/{ticket}，--project 不會被塞進 query', async function () {
  const calls = [];
  const out = collectIo();
  const code = await runCli(
    ['show', 'BUG-481', '--project', 'LTJ', '--json'],
    env(), out.io,
    jsonResponse(200, { data: { id: UUID, key: 'BUG-481' } }, calls)
  );
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].url, BASE + '/api/v1/tickets/BUG-481');
  assert.deepStrictEqual(JSON.parse(out.logs[0]), { id: UUID, key: 'BUG-481' });
});

test('runCli：comments 走 GET /tickets/{ticket}/comments', async function () {
  const calls = [];
  const out = collectIo();
  const code = await runCli(
    ['comments', 'BUG-481', '--limit', '20', '--order', 'asc', '--json'],
    env(), out.io,
    jsonResponse(200, { data: { items: [], nextCursor: null } }, calls)
  );
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].url, BASE + '/api/v1/tickets/BUG-481/comments?limit=20&order=asc');
});

test('runCli：activity 走 GET /tickets/{ticket}/activity 並支援 --kind', async function () {
  const calls = [];
  const out = collectIo();
  const code = await runCli(
    ['activity', 'BUG-481', '--kind', 'user', '--json'],
    env(), out.io,
    jsonResponse(200, { data: { items: [] } }, calls)
  );
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].url, BASE + '/api/v1/tickets/BUG-481/activity?kind=user');
});

test('runCli：activity 舊旗標 --comments/--system 明確擋下（exit 2，不送出）', async function () {
  const calls = [];
  const out = collectIo();
  const code = await runCli(
    ['activity', 'BUG-481', '--comments', '--system'],
    env(), out.io, jsonResponse(200, { data: {} }, calls)
  );
  assert.strictEqual(code, 2);
  assert.strictEqual(calls.length, 0);
  assert.match(out.errors[0], /kind/);
});

test('runCli：link 走 PUT /tickets/{childId}/parent，Idempotency-Key 只在 header', async function () {
  const calls = [];
  const out = collectIo();
  const code = await runCli(
    ['link', 'BUG-481', UUID, '--yes', '--idempotency-key', KEY, '--json'],
    env(), out.io,
    jsonResponse(200, { data: { id: UUID2, key: 'BUG-481', parentId: UUID } }, calls)
  );
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].url, BASE + '/api/v1/tickets/BUG-481/parent');
  assert.strictEqual(calls[0].init.method, 'PUT');
  assert.strictEqual(calls[0].init.headers['Idempotency-Key'], KEY);
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), { parentId: UUID });
});

test('runCli：comment 走 POST /tickets/{ticketId}/comments，body 只有 body/mentions', async function () {
  const calls = [];
  const out = collectIo();
  const code = await runCli(
    ['comment', 'BUG-481', '--body', '已修正', '--mention', UUID, '--project', 'LTJ',
      '--yes', '--idempotency-key', KEY, '--json'],
    env(), out.io,
    jsonResponse(201, { data: { id: UUID2, body: '已修正' } }, calls)
  );
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].url, BASE + '/api/v1/tickets/BUG-481/comments');
  assert.strictEqual(calls[0].init.method, 'POST');
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), { body: '已修正', mentions: [UUID] });
  assert.deepStrictEqual(JSON.parse(out.logs[0]), { id: UUID2, body: '已修正' });
});

test('runCli：comment 帶舊的 --to-status 直接擋下並提示獨立流轉（不偷偷丟）', async function () {
  const calls = [];
  const out = collectIo();
  const code = await runCli(
    ['comment', 'BUG-481', '--body', 'x', '--to-status', 'done', '--yes', '--idempotency-key', KEY],
    env(), out.io, jsonResponse(201, { data: {} }, calls)
  );
  assert.strictEqual(code, 2);
  assert.strictEqual(calls.length, 0);
  assert.match(out.errors[0], /流轉/);
});

test('runCli：attach 走 POST /tickets/{ticketId}/attachments 且不收 --kind', async function () {
  const calls = [];
  const out = collectIo();
  const ok = await runCli(
    ['attach', 'BUG-481', 'https://example.com/a.png', '--name', '截圖', '--yes', '--idempotency-key', KEY, '--json'],
    env(), out.io,
    jsonResponse(201, { data: { id: UUID, url: 'https://example.com/a.png' } }, calls)
  );
  assert.strictEqual(ok, 0);
  assert.strictEqual(calls[0].url, BASE + '/api/v1/tickets/BUG-481/attachments');
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), { url: 'https://example.com/a.png', name: '截圖' });

  const out2 = collectIo();
  const calls2 = [];
  const rejected = await runCli(
    ['attach', 'BUG-481', 'https://example.com/a.png', '--kind', 'image', '--yes', '--idempotency-key', KEY],
    env(), out2.io, jsonResponse(201, { data: {} }, calls2)
  );
  assert.strictEqual(rejected, 2);
  assert.strictEqual(calls2.length, 0);
});

test('runCli：寫入缺 --idempotency-key 直接本機擋下（exit 2，不送出）', async function () {
  const calls = [];
  const out = collectIo();
  const code = await runCli(
    ['comment', 'BUG-481', '--body', 'ok', '--yes'],
    env(), out.io, jsonResponse(200, { data: {} }, calls)
  );
  assert.strictEqual(code, 2);
  assert.strictEqual(calls.length, 0);
  assert.match(out.errors[0], /idempotency-key/);
});

test('runCli：契約未納入本包的指令不存在，未知指令回 exit 2 且不送出', async function () {
  const calls = [];
  const out = collectIo();
  const code = await runCli(['transition', 'BUG-481'], env(), out.io, jsonResponse(200, { data: {} }, calls));
  assert.strictEqual(code, 2);
  assert.strictEqual(calls.length, 0);
  assert.match(out.errors[0], /未知指令/);
});

test('runCli：業務錯誤原樣印出 error.code 並回 exit 1', async function () {
  const out = collectIo();
  const code = await runCli(
    ['search', '--project', 'LTJ'],
    env(), out.io,
    jsonResponse(401, { error: { code: 'unauthenticated', message: 'token 無效' } })
  );
  assert.strictEqual(code, 1);
  assert.strictEqual(out.errors[0], 'unauthenticated: token 無效');
});
