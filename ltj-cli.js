#!/usr/bin/env node

function parseCommand(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const command = args.shift();
  const options = parseOptions_(args);
  const json = !!options.flags.json;
  const yes = !!options.flags.yes;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help', action: '', params: {}, json, yes, write: false };
  }

  if (command === 'search') {
    return {
      command,
      action: 'searchTickets',
      params: compactParams_({
        q: options.values.q,
        type: options.values.type,
        status: options.values.status,
        assignee: options.values.assignee,
        creator: options.values.creator,
        version: options.values.version,
        module: options.values.module,
        subtype: options.values.subtype,
        limit: toNumberOrUndefined_(options.values.limit),
        cursor: options.values.cursor,
        sort: options.values.sort,
        order: options.values.order
      }),
      json,
      yes,
      write: false
    };
  }

  if (command === 'comments') {
    return {
      command,
      action: 'listComments',
      params: compactParams_({
        ticketId: options.positionals[0],
        limit: toNumberOrUndefined_(options.values.limit),
        cursor: options.values.cursor,
        order: options.values.order
      }),
      json,
      yes,
      write: false
    };
  }

  if (command === 'activity') {
    return {
      command,
      action: 'getActivityLog',
      params: compactParams_({
        ticketId: options.positionals[0],
        limit: toNumberOrUndefined_(options.values.limit),
        cursor: options.values.cursor,
        includeComments: toBoolOrUndefined_(options.values.comments),
        includeSystemEvents: toBoolOrUndefined_(options.values.system)
      }),
      json,
      yes,
      write: false
    };
  }

  if (command === 'link') {
    return {
      command,
      action: 'linkTickets',
      params: compactParams_({
        childId: options.positionals[0],
        parentId: options.positionals[1] === 'null' ? null : options.positionals[1],
        expectedUpdatedAt: toNumberOrUndefined_(options.values['expected-updated-at'])
      }),
      json,
      yes,
      write: true
    };
  }

  if (command === 'reply') {
    const transition = options.values['to-status'] ? { toStatus: options.values['to-status'] } : undefined;
    return {
      command,
      action: 'replyFeedback',
      params: compactParams_({
        ticketId: options.positionals[0],
        content: options.values.content,
        transition,
        expectedUpdatedAt: toNumberOrUndefined_(options.values['expected-updated-at'])
      }),
      json,
      yes,
      write: true
    };
  }

  if (command === 'attach') {
    return {
      command,
      action: 'attachLink',
      params: compactParams_({
        ticketId: options.positionals[0],
        url: options.positionals[1],
        name: options.values.name,
        kind: options.values.kind
      }),
      json,
      yes,
      write: true
    };
  }

  throw new Error('未知指令：' + command);
}

async function runCli(argv, env, io, fetchImpl) {
  const output = io || {
    log: (line) => console.log(line),
    error: (line) => console.error(line)
  };

  let parsed;
  try {
    parsed = parseCommand(argv);
  } catch (err) {
    output.error(err.message || String(err));
    printUsage_(output.error);
    return 2;
  }

  if (parsed.command === 'help') {
    printUsage_(output.log);
    return 0;
  }

  if (parsed.write && !parsed.yes) {
    output.error('寫入指令需要 --yes 確認');
    return 2;
  }

  const runtimeEnv = env || process.env;
  const url = runtimeEnv.LTJ_API_URL;
  const token = runtimeEnv.LTJ_API_TOKEN || runtimeEnv.LTJ_API_PAT;
  if (!url || !token) {
    output.error('缺少 LTJ_API_URL 或 LTJ_API_TOKEN（亦接受舊名 LTJ_API_PAT）');
    return 2;
  }

  const fetchFn = fetchImpl || globalThis.fetch;
  if (!fetchFn) {
    output.error('目前 Node.js runtime 沒有 fetch；請使用 Node 18+');
    return 2;
  }

  let envelope;
  try {
    // GH-303：寫入動作不重發第一段（避免已生效的寫入被執行第二次）
    envelope = await postLiteJiraApi(fetchFn, url, token, parsed.action, parsed.params, { write: parsed.write });
  } catch (err) {
    output.error(err.message || String(err));
    return 1;
  }

  if (!envelope.ok) {
    const error = envelope.error || {};
    output.error((error.code ? error.code + ': ' : '') + (error.message || 'API request failed'));
    return 1;
  }

  if (parsed.json) {
    output.log(JSON.stringify(envelope, null, 2));
  } else {
    output.log(formatHuman_(parsed.command, envelope.data));
  }
  return 0;
}

// LJ-116 批次 3: 錯誤訊息脫敏 — 截短 200 字 + 剝敏感 header 痕跡 + 遮罩 token 字串
function sanitizeErrorBody_(text) {
  if (!text) return '';
  // 1. 剝行首敏感 header 行
  const lines = String(text).split('\n').filter(function(line) {
    return !/^\s*(set-cookie|authorization|cookie|x-litejira-token|x-litejira-pat):/i.test(line);
  });
  let out = lines.join('\n');
  // 2. 遮罩 token 字串（Bearer xxx / ltj_pat_xxx / Authorization: ... 形態）
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***');
  out = out.replace(/ltj_pat_[A-Za-z0-9]+/gi, 'ltj_pat_***');
  out = out.replace(/Authorization\s*[:=]\s*[^,\s"]+/gi, 'Authorization: ***');
  out = out.replace(/Set-Cookie\s*[:=]\s*[^,\s"]+/gi, 'Set-Cookie: ***');
  // 3. 截短
  if (out.length > 200) out = out.slice(0, 200) + '...(截短)';
  return out;
}

// ── GH-303：Apps Script 兩段式回應的傳輸層韌性 ──
//
// POST /exec 實際上分兩段跑：
//   第一段 POST /exec                    → 指令碼在這裡執行完畢，回 302 指向暫存結果
//   第二段 GET  script.googleusercontent → 取回第一段算好的結果
//
// 2026-08-12 實測 25 輪唯讀請求：10 輪拿到 Google 的 HTML 錯誤頁而非 JSON
// （8 輪是第二段回 404，2 輪是第一段回 200 卻夾帶錯誤頁），失敗全部落在耗時 10 秒以上的請求。
// 舊版把這些回應的內容整段丟掉、只留「回傳非 JSON：HTTP 404」，所以現場證據從來留不下來。
//
// 重試的安全界線 —— 指令碼在第一段就跑完了：
//   第二段失敗時資料早已寫入，重發整個 POST 會讓寫入動作執行第二次。
//   伺服器端並未對 idempotencyKey 去重（只原樣回傳），擋不住重複。故：
//     第二段失敗 → 只重取第二段（純 GET 暫存結果，重取幾次都不會再次執行指令碼）
//     第一段     → 誰都只送一次，唯讀動作也不重發（量測依據見 postLiteJiraApi 內註解）
const RETRY_DELAYS_MS = [500, 1500];
// 逾時總預算：失敗案例本身就要 10~38 秒，沒有上限的話重試會把單次呼叫拖成數分鐘
const DEFAULT_BUDGET_MS = 45000;
// 第二段的單次逾時：實測正常只要 0.25~2.5 秒，失敗卻要乾等 10~30 秒才回 404。
// 設 8 秒把乾等換成早點重取。只對第二段設限 —— 中止一個純讀取沒有副作用，
// 中止第一段則不會讓已執行的寫入復原，故第一段不設。
const LEG2_TIMEOUT_MS = 8000;
// 第二段的導向跳數上限。正常情況是 0 跳（echo 直接回 JSON）；
// 給幾跳是為了不破壞一般 HTTP 服務的合法導向（相對路徑、同站搬移）。
const LEG2_MAX_REDIRECTS = 3;

// 301/302/303 依規範把 POST 轉成 GET，改用 GET 續跳不改變語意 → 當成第二段處理。
function isRedirect_(status) {
  return status === 301 || status === 302 || status === 303;
}

// 307/308 要求保留原方法。收到它代表對方「沒有處理這次請求，請改對新網址重送」，
// 所以重送不會造成重複寫入 —— 讀寫都可安全續跳，但必須維持 POST。
function isMethodPreservingRedirect_(status) {
  return status === 307 || status === 308;
}

// Location 允許是相對路徑（RFC 7231 §7.1.2）。不解析就直接餵 fetch 會拋出
// 「Failed to parse URL from /macros/echo?user_content_key=…」——把等同臨時憑證的
// 查詢字串原樣寫進例外訊息，繞過所有遮蔽。故一律先對基準網址解析。
// 解析不了（對方回畸形 Location）就回 null：不能退回原字串再去 fetch，
// 那等於把同一個洞留在退路上。
function resolveUrl_(location, base) {
  try {
    return new URL(String(location), String(base)).toString();
  } catch (err) {
    return null;
  }
}

// 307/308 會用原方法重送，而請求內容含存取權杖 —— 對方若把 Location 指向第三方主機，
// 權杖就送出去了。舊版靠 fetch 預設續跳時同樣有這個問題，但既然已接手導向處理，
// 就在這裡收斂成同源才續跳。
function isSameOrigin_(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch (err) {
    return false;
  }
}

// Apps Script 的「應用程式入口」：script.google.com/macros/s/<id>/exec（或 /dev、
// 或 Workspace 網域的 /a/macros/<domain>/s/<id>/exec）。
// 這個網址用 POST 打是叫 doPost 執行指令碼，用 GET 打是叫 doGet 出網頁 ——
// 兩者不是同一件事，GET 它永遠拿不到第一段算好的結果。
function isAppsScriptAppEntry_(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'script.google.com') return false;
    return /^\/(?:a\/macros\/[^/]+|macros)\/s\/[^/]+\/(?:exec|dev)$/.test(parsed.pathname);
  } catch (err) {
    return false;
  }
}

// 實測 Google 的結果網址會導回應用入口，原因尚未確定。
// 僅識別這個已驗證的 Google 路徑；一般服務可合法讓同一網址的 POST 與 GET 做不同事。
function isResultBounceTarget_(from, next, appUrl) {
  try {
    return new URL(from).origin === 'https://script.googleusercontent.com' &&
      new URL(appUrl).origin === 'https://script.google.com' && isAppsScriptAppEntry_(next);
  } catch (err) {
    return false;
  }
}

// 值得重試的狀態。200 也列入：實測第一段會回 200 卻夾帶 Google 錯誤頁，
// 走到這個判斷時已確認內容不是 JSON，所以 200 在此代表「拿到的不是結果」。
function isTransient_(status) {
  return status === 0 || status === 200 || status === 404 || status === 408 ||
    status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function headerOf_(response, name) {
  if (!response || !response.headers || typeof response.headers.get !== 'function') return '';
  return response.headers.get(name) || '';
}

// 診斷要看得出「最後連到哪個主機與路徑」，其餘一律砍掉。
// 憑證會出現在四個位置，只砍查詢字串不夠：
//   查詢字串 user_content_key=…、片段 #access_token=…、帳密 https://user:pw@host/、
//   路徑段 /JSESSIONID=…/。故用 URL 重組，只留通訊協定 + 主機 + 路徑，
//   路徑再過一次 sanitizeErrorBody_（只認得 ltj_pat_ / Bearer / Authorization /
//   Set-Cookie 四種形狀，夾在路徑段裡的其他 token 形式攔不到 —— 已知限制）。
function redactUrl_(url) {
  if (!url) return '(未取得)';
  const text = String(url);
  let parsed;
  try {
    parsed = new URL(text);
  } catch (err) {
    // 解析不了就只留問號前那段，且一樣過脫敏
    const mark = text.indexOf('?');
    return sanitizeErrorBody_(mark === -1 ? text : text.slice(0, mark)) + '（未能解析）';
  }
  const path = sanitizeErrorBody_(parsed.pathname || '/');
  const tail = (parsed.search || parsed.hash || parsed.username) ? '（查詢字串／片段／帳密已遮蔽）' : '';
  return parsed.protocol + '//' + parsed.host + path + tail;
}

function parseJson_(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

// 舊版 Node 沒有 AbortSignal.timeout；沒有就不設限，行為退回加逾時之前
function timeoutSignal_(ms) {
  if (!ms || typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return undefined;
  return AbortSignal.timeout(ms);
}

// 非 JSON 回應只取 <title>，不夾帶原始內容。
//
// LJ-116 當初刻意不回 body（見 tests/lj-116-mcp-schema-strict.test.js 的
// test_LJ116_ltj_cli_non_json_path）：HTML 登入頁可能夾帶憑證，而 sanitizeErrorBody_
// 只認得 ltj_pat_ / Bearer / Authorization / Set-Cookie 這幾種形狀，
// 認不出 <input value="…">、nonce="…" 之類。這個顧慮成立。
//
// 但完全不給內容就診斷不了 GH-303。折衷是只取 <title>：實測它已足以分辨兩種失敗
// （「找不到網頁」= Google 側取結果故障、「LiteJira — 無權限」= 導向鏈繞回 doGet），
// 而 <title> 不是憑證會出現的位置。取出來仍再過一次 sanitizeErrorBody_。
function summarizeBody_(text) {
  const raw = String(text || '');
  // 判準是「能不能解析成 JSON」，不是 content-type 或內容開頭 ——
  // 那兩個都由回應方決定，對方只要不宣告 html、內容不以 <!doctype 起頭，
  // 就能讓夾帶憑證的頁面走進「倒 200 字原文」那條路。
  //
  // JSON 分支沿用 LJ-116 既有脫敏（那是既有契約，見主庫
  // tests/lj-116-mcp-schema-strict.test.js 的 strips_cookies 一條）。
  // 已知限制：能解析成 JSON 但夾帶憑證的回應仍會倒 200 字（經脫敏）。
  // 我方 API 一律回 200 + 信封並在上層提前 return，走到這裡的 JSON 必然不是我方回應；
  // Apps Script 也不會回非 2xx 的 JSON，故實務上碰不到。改動前同樣如此，非本次退步。
  if (parseJson_(raw) !== null) return sanitizeErrorBody_(raw);

  // 標題只從 <head> 內第一個 <title> 取。屬性值可能含 `>`（如 <title data-x="a>b">），
  // 故屬性段用 (?:"[^"]*"|'[^']*'|[^>])* 正確跳過引號內的 `>`。
  const matched = raw.match(/<title(?:"[^"]*"|'[^']*'|[^>])*>([\s\S]{0,120}?)<\/title\s*>/i);
  let title = String((matched && matched[1]) || '').replace(/\s+/g, ' ').trim();
  // 標題可能回顯被擋的網址（攔截式 proxy 常這樣寫），裡面就會夾帶 user_content_key
  title = title.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '（網址已遮蔽）');
  title = sanitizeErrorBody_(title);
  return title ? '頁面標題：' + title : '非 JSON 回應（無標題，未夾帶原始內容）';
}

// code 是給上層程式判讀用的（錯誤訊息本身是給人看的，不該被解析）
function legTag_(leg) {
  return leg === '一' ? 'leg1' : 'leg2';
}

function describeFailure_(response, text, leg, fallbackUrl) {
  return {
    leg,
    code: legTag_(leg) + '_http_' + (response ? response.status : 0),
    status: response ? response.status : 0,
    contentType: headerOf_(response, 'content-type'),
    // 一律存遮蔽後的網址：這個物件的註解邀請上層記錄它，存原始字串等於請人把
    // user_content_key 寫進紀錄檔
    finalUrl: redactUrl_((response && response.url) || fallbackUrl || ''),
    body: summarizeBody_(text)
  };
}

// 連線層例外（逾時中止、DNS 失敗、對方中途斷線）的訊息不是我們寫的，可能含請求內容
// 或網址，故一律過脫敏 + 截短，不可原樣放行。
function describeThrown_(err, leg, fallbackUrl) {
  return {
    leg,
    code: legTag_(leg) + '_network_error',
    status: 0,
    contentType: '',
    finalUrl: redactUrl_(fallbackUrl || ''),
    body: sanitizeErrorBody_(String((err && err.message) || err))
  };
}

// GH-303：錯誤訊息帶齊判讀所需的 —— 哪一段壞的、最後連到哪、對方回什麼格式、頁面標題
function transportError_(failure, requestId, attempts, isWrite) {
  const info = failure || { leg: '未知', status: 0, contentType: '', finalUrl: '', body: '' };
  // 兩種情況下寫入可能已生效：
  //   第二段失敗 —— 指令碼確定已在第一段執行完畢
  //   status 0（連線層拋例外）—— 連線在送出後中斷時，伺服器可能已收完內容並寫入。
  //     實測：伺服器寫完再切斷連線，client 只看得到「第一段失敗」，但資料已經進去了。
  //     分不出「還沒送到」與「送到了但回不來」，故一律當可能已生效。
  // 不講明的話，上層（LLM 或 worker 的自動重試）會把「傳輸失敗」讀成「沒生效」而重打，
  // 而伺服器端不去重，那就是第二筆寫入。
  const writeMayHaveApplied = Boolean(isWrite) && (info.leg === '二' || info.status === 0);
  const error = new Error(
    'LiteJira API 傳輸失敗：HTTP ' + info.status + '（第' + info.leg + '段，共嘗試 ' + attempts + ' 次）' +
    '\n  code: ' + (info.code || '(無)') +
    '\n  requestId: ' + requestId +
    '\n  最終網址: ' + info.finalUrl +
    '\n  content-type: ' + (info.contentType || '(無)') +
    '\n  回應內容: ' + (info.body || '(空)') +
    (info.redirects && info.redirects.length > 1 ? '\n  導向: ' + info.redirects.join(' → ') : '') +
    (info.firstFailure
      ? '\n  第一次失敗: HTTP ' + info.firstFailure.status +
        '（' + (info.firstFailure.code || '無 code') + '）' + (info.firstFailure.body || '(空)')
      : '') +
    // 這句是給人看的：失效導向長得跟「沒有工單權限」一模一樣，不講明就會查錯方向。
    // 但只證明「取結果被導回入口」，不知道 Google 內部原因，不能反過來宣稱權限沒問題、
    // 也不能宣稱指令碼一定已執行完 —— 故不下結論，只描述觀察到的現象。
    (info.code === 'leg2_result_unavailable'
      ? '\n  ℹ️ 取結果的請求被導向繞回應用程式入口（該入口未被 GET），結果未取得 —— ' +
        '\n     不能據此判定是工單或帳號權限不足，也無法確認 Google 端內部原因。'
      : '') +
    (writeMayHaveApplied
      ? '\n  ⚠️ 這是寫入動作，且失敗在取回結果的階段 —— 無法確認指令碼是否已執行，寫入仍可能已生效。' +
        '\n     重送會寫第二遍（伺服器端不對 idempotencyKey 去重）。請先查工單現況再決定。'
      : '')
  );
  // 讓上層改判斷 / 記錄時不必解析錯誤字串（finalUrl 已是遮蔽版）
  info.writeMayHaveApplied = writeMayHaveApplied;
  error.litejiraTransport = info;
  // 「第一段只送一次」只是這個函數的不變式，擋不住呼叫端整個再呼叫一次。
  // scripts/litejira-worker.js 的 classifyWorkerError_ 把沒有 code 的錯誤判為
  // 可重試，會把同一則留言重送 3 次 —— 正是本工單要防的重複寫入，只是搬到呼叫端。
  // 該函數已支援 err.transient === false（走終止路徑不重試），故在這裡掛旗標，
  // 不必改 worker。這是唯一能把「寫入可能已生效」變成實際行為的接點。
  if (writeMayHaveApplied) error.transient = false;
  return error;
}

// 第二段的單次取回：自己走導向，才能在跳去應用入口之前攔下來。
// 導向鏈只記錄遮蔽後的 host+path（暫存結果網址的查詢字串等同臨時憑證）。
// 逾時中止可能從 fetch 或 text() 任一處拋出，一律讓它往外拋給呼叫端統一處理。
async function fetchLeg2Once_(fetchFn, startUrl, ctx) {
  const chain = [redactUrl_(startUrl)];
  let current = startUrl;
  // 逾時是整段（起始請求 + 所有跳轉 + 讀 body）共用同一個上限，不是每一跳各自 8 秒 ——
  // 否則 3 跳就變相把逾時放寬到 32 秒，等於沒設限。故在迴圈外建一次，所有 fetch/text() 共用。
  const signal = timeoutSignal_(ctx.leg2TimeoutMs);
  for (let hop = 0; ; hop++) {
    const response = await fetchFn(current, { redirect: 'manual', signal });
    const location = headerOf_(response, 'location');
    const redirecting = (isRedirect_(response.status) || isMethodPreservingRedirect_(response.status)) && location;
    if (!redirecting) {
      // 沒有導向 → 結果（或錯誤頁）就在這裡。text() 與 fetch 同樣可能拋中止例外。
      return { response, text: await response.text(), url: current, chain };
    }
    // 導向不會被消費，body 留著等下一跳；沒有下一跳的分支已經在上面呼叫 text() 讀掉了，
    // 這裡的 response 一律有導向、不會被回傳，須主動釋放底層連線避免 undici socket 卡住。
    if (response.body && typeof response.body.cancel === 'function') {
      response.body.cancel().catch(function () {});
    }
    if (hop >= LEG2_MAX_REDIRECTS) {
      return { stopped: true, code: 'leg2_too_many_redirects', status: response.status, url: current, chain,
        body: '第二段導向超過 ' + LEG2_MAX_REDIRECTS + ' 跳，已停止' };
    }
    const next = resolveUrl_(location, current);
    if (!next || !/^https?:$/i.test(new URL(next).protocol)) {
      return { stopped: true, code: 'leg2_bad_redirect', status: response.status, url: current, chain,
        body: '第二段的導向目標無法解析為合法的 http(s) 網址' };
    }
    if (isResultBounceTarget_(current, next, ctx.appUrl)) {
      return { stopped: true, code: 'leg2_result_unavailable', status: response.status, url: current,
        chain: chain.concat(redactUrl_(next)),
        body: '取結果被導向繞回應用程式入口，結果未取得（原因不明）。GET 那個入口只會回應用網頁而非結果，故未發出該請求' };
    }
    chain.push(redactUrl_(next));
    current = next;
  }
}

// 第二段：取回暫存結果。重取只是再讀一次已算好的結果，不會再次執行指令碼，故讀寫都安全。
async function fetchStashedResult_(fetchFn, location, ctx) {
  let failure = null;
  let firstFailure = null;
  const remember = (f) => { failure = f; if (!firstFailure) firstFailure = f; return f; };
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      if (Date.now() > ctx.deadline) break;
      await ctx.sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
    ctx.attempts++;
    let hop;
    try {
      hop = await fetchLeg2Once_(fetchFn, location, ctx);
    } catch (err) {
      // 逾時中止也走這裡：純讀取被中止沒有副作用，下一輪重取即可
      remember(describeThrown_(err, '二', location));
      continue;
    }
    if (hop.stopped) {
      remember({ leg: '二', status: hop.status, contentType: '', finalUrl: redactUrl_(hop.url),
        body: hop.body, code: hop.code, redirects: hop.chain });
      // 已辨識的異常導向立即停止，避免進入網頁後掩蓋原本的失敗。
      break;
    }
    if (hop.response.status >= 200 && hop.response.status < 300) {
      const payload = parseJson_(hop.text);
      if (payload !== null) return { payload };
    }
    const current = remember(describeFailure_(hop.response, hop.text, '二', hop.url));
    if (hop.chain.length > 1) current.redirects = hop.chain;
    if (!isTransient_(current.status)) break;
  }
  // 最後一次失敗未必是最有診斷價值的那次（例：第一次逾時、第二次才撞上失效導向）
  if (failure && firstFailure && failure !== firstFailure) {
    failure.firstFailure = { status: firstFailure.status, code: firstFailure.code || '', body: firstFailure.body };
  }
  return { failure };
}

async function postLiteJiraApi(fetchFn, url, token, action, params, options) {
  const opts = options || {};
  // write 只影響錯誤訊息要不要警告「寫入可能已生效」，不影響重試次數 ——
  // 第一段對誰都只送一次（見下方 measured 註解）。預設當寫入：漏傳旗標時寧可多警告。
  const isWrite = opts.write !== false;
  const requestId = opts.requestId || ('ltj-' + Date.now());
  const ctx = {
    attempts: 0,
    deadline: Date.now() + (opts.budgetMs === undefined ? DEFAULT_BUDGET_MS : opts.budgetMs),
    leg2TimeoutMs: opts.leg2TimeoutMs === undefined ? LEG2_TIMEOUT_MS : opts.leg2TimeoutMs,
    appUrl: url, // 第二段用來辨認「導向繞回應用入口」＝結果失效

    sleep: opts.sleep || function (ms) { return new Promise(function (done) { setTimeout(done, ms); }); }
  };
  const init = {
    method: 'POST',
    redirect: 'manual', // 自己接手導向，才能只重取第二段而不重發第一段
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, action, params, requestId })
  };

  // 第一段對誰都只送一次 —— 唯讀動作也不重發。
  //
  // 量測依據（2026-08-12 正式環境交錯對照，新舊實作相鄰執行、順序交替，各 20 輪）：
  //   舊實作                失敗 35%  中位數 10603ms  最慢 44346ms
  //   重發第一段 + 重取第二段  失敗 25%  中位數 30347ms  最慢 72976ms
  //   只重取第二段           失敗 25%  中位數 13057ms  最慢 40770ms
  // 重發第一段對失敗率零貢獻（兩種設定都是 25%），只換來 17 秒中位數延遲 ——
  // 因為第一段本身要 3~45 秒，而第二段正常只要 0.25~2.5 秒。
  //
  // 附帶好處是安全性不再依賴呼叫端記得傳旗標：第一段只送一次是這個函數的不變式，
  // 漏傳 options 的呼叫端（scripts/litejira-worker.js、scripts/litejira-api-smoke.js）
  // 也不可能重複寫入。
  ctx.attempts++;
  let response = null;
  let rawLocation = '';
  try {
    response = await fetchFn(url, init);
    rawLocation = headerOf_(response, 'location');
    // 307/308 語意是「這次沒處理，改對新網址用原方法重送」→ 重送不會造成重複寫入。
    // 舊版預設自動續跳、能正常運作，改成手動接手後必須自己補上，否則等於砍掉這條路。
    // 只續跳一次、且限同源：連續 308 不會變成迴圈，權杖也不會被導去第三方主機。
    if (isMethodPreservingRedirect_(response.status) && rawLocation) {
      const next = resolveUrl_(rawLocation, url);
      if (next && isSameOrigin_(next, url)) {
        if (response.body && typeof response.body.cancel === 'function') {
          response.body.cancel().catch(function () {});
        }
        ctx.attempts++;
        response = await fetchFn(next, init);
        rawLocation = headerOf_(response, 'location');
      }
    }
  } catch (err) {
    throw transportError_(describeThrown_(err, '一', url), requestId, ctx.attempts, isWrite);
  }

  if (!isRedirect_(response.status) || !rawLocation) {
    // 沒有導向 → 結果或錯誤就在這一段（測試替身、以及第一段直接回 HTML 錯誤頁的情境）
    let text;
    try {
      text = await response.text();
    } catch (err) {
      throw transportError_(describeThrown_(err, '一', url), requestId, ctx.attempts, isWrite);
    }
    const payload = parseJson_(text);
    if (payload !== null && response.status >= 200 && response.status < 300) return payload;
    throw transportError_(describeFailure_(response, text, '一', url), requestId, ctx.attempts, isWrite);
  }

  const stashUrl = resolveUrl_(rawLocation, url);
  if (!stashUrl) {
    throw transportError_(
      { leg: '一', code: 'leg1_bad_redirect', status: response.status, contentType: headerOf_(response, 'content-type'),
        finalUrl: redactUrl_(url), body: '導向目標無法解析為合法網址' },
      requestId, ctx.attempts, isWrite);
  }
  const stashed = await fetchStashedResult_(fetchFn, stashUrl, ctx);
  if (stashed.payload !== undefined) return stashed.payload;
  throw transportError_(stashed.failure, requestId, ctx.attempts, isWrite);
}

function parseOptions_(args) {
  const positionals = [];
  const values = {};
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg || arg.indexOf('--') !== 0) {
      positionals.push(arg);
      continue;
    }

    const raw = arg.slice(2);
    const eq = raw.indexOf('=');
    const key = eq === -1 ? raw : raw.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);
    if (key === 'json' || key === 'yes') {
      flags[key] = true;
      continue;
    }

    if (inlineValue !== undefined) {
      values[key] = inlineValue;
    } else if (i + 1 < args.length && String(args[i + 1]).indexOf('--') !== 0) {
      values[key] = args[++i];
    } else {
      values[key] = 'true';
    }
  }
  return { positionals, values, flags };
}

function compactParams_(params) {
  const out = {};
  Object.keys(params).forEach((key) => {
    if (params[key] !== undefined && params[key] !== '') out[key] = params[key];
  });
  return out;
}

function toNumberOrUndefined_(value) {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toBoolOrUndefined_(value) {
  if (value === undefined || value === '') return undefined;
  if (String(value).toLowerCase() === 'false') return false;
  if (String(value).toLowerCase() === 'true') return true;
  return undefined;
}

function formatHuman_(command, data) {
  if (!data) return '';
  if (Array.isArray(data.items)) {
    if (data.items.length === 0) return 'No results';
    return data.items.map(formatItem_).join('\n');
  }
  if (Array.isArray(data.rows)) {
    if (data.rows.length === 0) return 'No results';
    return data.rows.map(formatItem_).join('\n');
  }
  if (command === 'link') return 'Linked ' + (data.childId || '') + ' -> ' + (data.parentId || '');
  if (command === 'attach') return data.added ? 'Attached link' : 'Link already attached';
  if (command === 'reply') return 'Replied to ' + (data.ticketId || '');
  return JSON.stringify(data, null, 2);
}

function formatItem_(item) {
  if (!item || typeof item !== 'object') return String(item);
  return [
    item.id || item.ticketId || '',
    item.title || item.content || item.status || '',
    item.status || '',
    item.assignee || item.author || ''
  ].filter(Boolean).join('\t');
}

function printUsage_(writeLine) {
  writeLine('用法:');
  writeLine('  ltj search [--q text] [--type BUG] [--json]');
  writeLine('  ltj comments <ticketId> [--json]');
  writeLine('  ltj activity <ticketId> [--json]');
  writeLine('  ltj link <childId> <parentId|null> --yes');
  writeLine('  ltj reply <ticketId> --content text --yes');
  writeLine('  ltj attach <ticketId> <url> --yes');
}

module.exports = {
  parseCommand,
  runCli,
  postLiteJiraApi
};

if (require.main === module) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
