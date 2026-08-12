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
//     第二段失敗 → 只重取第二段（純 GET 暫存結果，重取幾次都不會再次執行指令碼），讀寫皆安全
//     第一段失敗 → 只有唯讀動作重發；寫入動作直接拋錯，把證據交給呼叫端判斷
const RETRY_DELAYS_MS = [500, 1500];
// 逾時總預算：失敗案例本身就要 10~38 秒，沒有上限的話重試會把單次呼叫拖成數分鐘
const DEFAULT_BUDGET_MS = 45000;
// 第二段的單次逾時：實測正常只要 0.25~2.5 秒，失敗卻要乾等 10~30 秒才回 404。
// 設 8 秒把乾等換成早點重取。只對第二段設限 —— 中止一個純讀取沒有副作用，
// 中止第一段則不會讓已執行的寫入復原，故第一段不設。
const LEG2_TIMEOUT_MS = 8000;

// 只認 301/302/303 —— 這三種依規範本來就把 POST 轉成 GET，改用 GET 續跳不改變語意。
// 307/308 要求保留原方法，不可當成第二段處理，故留給下面的「沒有導向」分支拋錯（帶完整證據）。
function isRedirect_(status) {
  return status === 301 || status === 302 || status === 303;
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

// 診斷要看得出「最後連到哪個主機」，但查詢字串含 user_content_key（等同臨時憑證）故遮蔽
function redactUrl_(url) {
  if (!url) return '(未取得)';
  const text = String(url);
  const mark = text.indexOf('?');
  return mark === -1 ? text : text.slice(0, mark) + '?…(參數已遮蔽)';
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

function describeFailure_(response, text, leg, fallbackUrl) {
  return {
    leg,
    status: response ? response.status : 0,
    contentType: headerOf_(response, 'content-type'),
    finalUrl: (response && response.url) || fallbackUrl || '',
    body: sanitizeErrorBody_(text)
  };
}

// GH-303：錯誤訊息帶齊判讀所需的四樣 —— 哪一段壞的、最後連到哪、對方回什麼格式、內容前 200 字
function transportError_(failure, requestId, attempts) {
  const info = failure || { leg: '未知', status: 0, contentType: '', finalUrl: '', body: '' };
  const error = new Error(
    'LiteJira API 傳輸失敗：HTTP ' + info.status + '（第' + info.leg + '段，共嘗試 ' + attempts + ' 次）' +
    '\n  requestId: ' + requestId +
    '\n  最終網址: ' + redactUrl_(info.finalUrl) +
    '\n  content-type: ' + (info.contentType || '(無)') +
    '\n  回應內容: ' + (info.body || '(空)')
  );
  // 讓上層改判斷 / 記錄時不必解析錯誤字串
  error.litejiraTransport = info;
  return error;
}

// 第二段：取回暫存結果。重取只是再讀一次已算好的結果，不會再次執行指令碼，故讀寫都安全。
async function fetchStashedResult_(fetchFn, location, ctx) {
  let failure = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      if (Date.now() > ctx.deadline) break;
      await ctx.sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
    ctx.attempts++;
    let response;
    try {
      response = await fetchFn(location, { redirect: 'follow', signal: timeoutSignal_(ctx.leg2TimeoutMs) });
    } catch (err) {
      // 逾時中止也走這裡：純讀取被中止沒有副作用，下一輪重取即可
      failure = { leg: '二', status: 0, contentType: '', finalUrl: location, body: String((err && err.message) || err) };
      continue;
    }
    const text = await response.text();
    if (response.status >= 200 && response.status < 300) {
      const payload = parseJson_(text);
      if (payload) return { payload };
    }
    failure = describeFailure_(response, text, '二', location);
    if (!isTransient_(failure.status)) break;
  }
  return { failure };
}

async function postLiteJiraApi(fetchFn, url, token, action, params, options) {
  const opts = options || {};
  const isWrite = Boolean(opts.write);
  const requestId = opts.requestId || ('ltj-' + Date.now());
  const ctx = {
    attempts: 0,
    deadline: Date.now() + (opts.budgetMs || DEFAULT_BUDGET_MS),
    leg2TimeoutMs: opts.leg2TimeoutMs === undefined ? LEG2_TIMEOUT_MS : opts.leg2TimeoutMs,
    sleep: opts.sleep || function (ms) { return new Promise(function (done) { setTimeout(done, ms); }); }
  };
  const init = {
    method: 'POST',
    redirect: 'manual', // 自己接手導向，才能只重取第二段而不重發第一段
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, action, params, requestId })
  };

  // 寫入動作的第一段只打一次：重發會讓已生效的寫入再執行一遍
  const maxFirstLeg = isWrite ? 1 : RETRY_DELAYS_MS.length + 1;
  let failure = null;

  for (let attempt = 0; attempt < maxFirstLeg; attempt++) {
    if (attempt > 0) {
      if (Date.now() > ctx.deadline) break;
      await ctx.sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
    ctx.attempts++;

    let response;
    try {
      response = await fetchFn(url, init);
    } catch (err) {
      failure = { leg: '一', status: 0, contentType: '', finalUrl: url, body: String((err && err.message) || err) };
      continue;
    }

    const location = headerOf_(response, 'location');
    if (!isRedirect_(response.status) || !location) {
      // 沒有導向 → 結果或錯誤就在這一段（測試替身、以及第一段直接回 HTML 錯誤頁的情境）
      const text = await response.text();
      const payload = parseJson_(text);
      if (payload && response.status >= 200 && response.status < 300) return payload;
      failure = describeFailure_(response, text, '一', url);
      if (!isTransient_(failure.status)) break;
      continue;
    }

    const stashed = await fetchStashedResult_(fetchFn, location, ctx);
    if (stashed.payload) return stashed.payload;
    failure = stashed.failure;
    if (isWrite) break; // 寫入已生效，不可再發第一段
    if (Date.now() > ctx.deadline) break;
  }

  throw transportError_(failure, requestId, ctx.attempts);
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
