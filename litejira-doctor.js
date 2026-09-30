'use strict';

// `litejira-mcp doctor`：驗證「主機設定檔裡實際寫的那條指令」真的能跑起來一個可用的 MCP server。
//
// 它刻意**不**重新推導該怎麼啟動，而是把設定檔裡的 command / args 原樣讀出來執行 ——
// 這樣才測得到「設定檔寫錯 / 路徑失效 / 舊版殘留」這一類真正會讓使用者卡住的問題。
//
// 誠實邊界：本檢查只證明「這條指令起得來、協定通、讀得到資料」。
// 它**不能**證明 Codex / Claude Code / Gemini 這些主機已經載入新設定 ——
// 主機何時重讀設定不在我們手上，所以輸出裡是 hostReloadRequired，不是「已生效」。
//
// 唯讀：子行程一律帶 LTJ_MCP_ENABLE_WRITES=false，且只呼叫讀取類的方法。

const { spawn } = require('child_process');

const hosts = require('./litejira-hosts');
const { resolveSettings } = require('./litejira-config');
const { readCredFile, resolveTargetFile } = require('./litejira-setup');

const PKG_VERSION = require('./package.json').version;
const DEFAULT_TIMEOUT_MS = 20000;

// 任何輸出（含子行程 stderr 與例外訊息）都先過這一關：secret 一律換成 ***。
function makeRedactor(secrets) {
  const list = (secrets || []).filter(function (s) { return typeof s === 'string' && s.length >= 6; });
  return function redact(text) {
    let out = String(text === undefined || text === null ? '' : text);
    for (const secret of list) out = out.split(secret).join('***');
    return out;
  };
}

// 子行程輸出的上限：設定檔可能指到一個「一直吐東西」的程式，不能讓 doctor 自己吃爆記憶體。
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_STDOUT_BUFFER_BYTES = 1024 * 1024;

function jsonRpcClient(command, args, env, timeoutMs, redact) {
  const child = spawn(command, args, {
    env: env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const pending = new Map();                       // id → { resolve, reject, timer }
  let stderrText = '';
  let buffer = '';
  let dead = null;                                 // 已知的致命狀態（spawn 失敗 / 子行程結束）

  // 命令不存在（ENOENT）是非同步事件：不先把所有等待中的請求叫醒，
  // 呼叫端就會白等到逾時，還留下一個沒收乾淨的子行程。
  function failAll(err) {
    if (!dead) dead = err;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(dead);
    }
  }

  child.on('error', function (err) {
    failAll(new Error('無法啟動設定檔裡的指令（' + redact(err.code || 'error') + '）：' + redact(err.message)));
  });
  child.on('close', function (code, signal) {
    failAll(new Error('子行程結束（code=' + code + (signal ? ', signal=' + signal : '') + '）：'
      + redact(stderrText).trim().slice(-400)));
  });
  // stdin 的 EPIPE 會冒成 unhandled error：接住它，當成「子行程已經不在了」。
  child.stdin.on('error', function (err) {
    if (err && err.code === 'EPIPE') return;
    failAll(new Error('寫入子行程 stdin 失敗：' + redact(err.message)));
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', function (chunk) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === '') continue;
      let message;
      try { message = JSON.parse(line); } catch (_) { continue; }
      const entry = pending.get(message.id);
      if (entry) { pending.delete(message.id); clearTimeout(entry.timer); entry.resolve(message); }
    }
    // 一直沒有換行 = 對方不是走 JSON-RPC over stdio，別把它整包留在記憶體裡。
    if (buffer.length > MAX_STDOUT_BUFFER_BYTES) buffer = buffer.slice(-MAX_STDOUT_BUFFER_BYTES);
  });
  child.stdout.on('error', function () { /* 收尾時的 EPIPE / ECONNRESET：忽略 */ });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', function (chunk) {
    stderrText = (stderrText + chunk).slice(-MAX_STDERR_BYTES);
  });
  child.stderr.on('error', function () { /* 同上 */ });

  let nextId = 0;
  return {
    call: function (method, params) {
      const id = ++nextId;
      return new Promise(function (resolve, reject) {
        if (dead) { reject(dead); return; }
        const timer = setTimeout(function () {
          pending.delete(id);
          reject(new Error(method + ' 逾時（' + timeoutMs + 'ms）'));
        }, timeoutMs);
        pending.set(id, { resolve: resolve, reject: reject, timer: timer });
        try {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }) + '\n');
        } catch (err) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error('寫入 stdin 失敗：' + redact(err.message)));
        }
      });
    },
    notify: function (method, params) {
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: method, params: params || {} }) + '\n');
      } catch (_) { /* 已結束就忽略 */ }
    },
    stderr: function () { return redact(stderrText); },
    stop: function () {
      failAll(new Error('檢查已結束'));
      try { child.stdin.end(); } catch (_) { /* ignore */ }
      try { child.stdout.destroy(); } catch (_) { /* ignore */ }
      try { child.stderr.destroy(); } catch (_) { /* ignore */ }
      // kill 之後再給一小段時間；沒死就 SIGKILL，免得留下孤兒行程。
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch (_) { /* ignore */ }
        const hard = setTimeout(function () {
          try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
        }, 2000);
        if (hard.unref) hard.unref();
        child.once('close', function () { clearTimeout(hard); });
      }
    }
  };
}

function resultOf(response, label) {
  if (!response) throw new Error(label + ' 沒有回應');
  if (response.error) throw new Error(label + ' 回 error：' + (response.error.message || response.error.code));
  if (response.result === undefined) throw new Error(label + ' 沒有 result');
  return response.result;
}

// 用設定檔裡的 command / args 起一輪唯讀檢查。回傳 { stdioVerified, version, checks }。
async function verifyStdio(entry, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const redact = opts.redact || makeRedactor([]);
  const checks = [];
  const env = Object.assign({}, opts.baseEnv || process.env, entry.env || {}, {
    LTJ_MCP_ENABLE_WRITES: 'false',
    LTJ_MCP_NO_UPDATE_CHECK: '1'
  });
  const client = jsonRpcClient(entry.command, entry.args || [], env, timeoutMs, redact);
  let version = null;
  try {
    const init = resultOf(await client.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'litejira-mcp-doctor', version: PKG_VERSION }
    }), 'initialize');
    version = init.serverInfo && init.serverInfo.version;
    checks.push({ name: 'initialize', ok: true, detail: 'serverInfo.version=' + version });
    client.notify('notifications/initialized');

    if (version !== PKG_VERSION) {
      checks.push({
        name: 'versionMatch',
        ok: false,
        detail: '設定檔啟動到的是 ' + version + '，但本次執行的套件是 ' + PKG_VERSION
          + '（設定檔可能指向舊的安裝路徑）'
      });
    } else {
      checks.push({ name: 'versionMatch', ok: true, detail: version });
    }

    const tools = resultOf(await client.call('tools/list', {}), 'tools/list');
    const names = (tools.tools || []).map(function (t) { return t.name; });
    const hasSearch = names.indexOf('litejira.searchTickets') !== -1;
    checks.push({ name: 'tools/list', ok: hasSearch, detail: names.length + ' 個工具' + (hasSearch ? '' : '（缺 litejira.searchTickets）') });

    const meta = resultOf(await client.call('resources/read', { uri: 'litejira://meta' }), 'litejira://meta');
    checks.push({ name: 'resources/read litejira://meta', ok: Array.isArray(meta.contents) && meta.contents.length > 0, detail: '讀到 meta' });

    const search = resultOf(await client.call('tools/call', {
      name: 'litejira.searchTickets',
      arguments: { limit: 1 }
    }), 'searchTickets');
    if (search.isError) {
      throw new Error('searchTickets 回 isError：' + redact((search.content || []).map(function (c) { return c.text; }).join(' ')));
    }
    checks.push({ name: 'tools/call litejira.searchTickets', ok: true, detail: '唯讀查詢成功' });
  } catch (err) {
    checks.push({ name: 'stdio', ok: false, detail: redact(err && err.message ? err.message : String(err)) });
  } finally {
    client.stop();
  }
  return {
    stdioVerified: checks.length > 0 && checks.every(function (c) { return c.ok; }),
    version: version,
    checks: checks
  };
}

// 主入口。回傳 { code, report }；report 就是 --json 要印的那個物件。
async function runDoctor(argv, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const args = Array.isArray(argv) ? argv.slice() : [];
  const ctx = hosts.makeContext({ env: env, cwd: opts.cwd, home: opts.home });

  let client = null;
  let target = '';
  let timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--client') { client = String(args[++i] || '').toLowerCase(); continue; }
    if (arg.startsWith('--client=')) { client = arg.slice('--client='.length).toLowerCase(); continue; }
    if (arg === '--timeout-ms') { timeoutMs = parseInt(args[++i], 10) || timeoutMs; continue; }
    if (arg === '--json') continue;                      // doctor 一律輸出 JSON
    if (arg === 'prod' || arg === 'dev') { target = arg; continue; }
    return { code: 2, report: { ok: false, error: 'unknown_argument', message: '不認得的參數：' + arg } };
  }

  const clients = client && client !== 'auto' ? [client] : hosts.detectClients(ctx);
  if (clients.length === 0) {
    return {
      code: 2,
      report: {
        ok: false,
        error: 'no_host_detected',
        message: '找不到任何已安裝的 AI 主機設定目錄（~/.codex、~/.claude.json、~/.gemini）。'
          + '請用 --client codex|claude|gemini 明指目標。'
      }
    };
  }

  // 憑證只用來 (a) 讓子行程有得用、(b) 做 redact；絕不放進輸出。
  const credFile = resolveTargetFile(target, opts.dir).file;
  const cred = readCredFile(credFile);
  const settings = resolveSettings(Object.assign({}, cred.values, pickToken_(env)));
  const redact = makeRedactor([settings.token, env.LTJ_API_TOKEN, env.LTJ_API_PAT]);
  // 子行程的環境要「像 AI 主機那樣」：不補 token、也不轉送這個 shell 的 LTJ_*。
  // 補了就變成我們自己餵答案 —— 憑證檔沒寫好這種問題會驗不出來，而那正是 doctor 要抓的。
  const baseEnv = {};
  for (const key of Object.keys(env)) {
    if (/^LTJ_/.test(key)) continue;
    baseEnv[key] = env[key];
  }

  const report = {
    ok: false,
    package: { name: 'litejira-mcp', version: PKG_VERSION },
    credentialsFile: credFile,
    credentialsPresent: !!settings.token,
    apiUrl: settings.apiUrl,
    project: settings.project,
    clients: [],
    hostReloadRequired: true,
    hostReloadNote: 'doctor 只證明設定檔裡那條指令可以起來且協定通；'
      + '主機（Codex / Claude Code / Gemini）是否已載入新設定不在本工具掌握範圍，請依各主機方式重連或重啟。'
  };

  for (const id of clients) {
    const host = hosts.HOSTS[id];
    if (!host) {
      report.clients.push({ client: id, configured: false, stdioVerified: false, error: 'unknown_client' });
      continue;
    }
    const read = host.read(ctx);
    const item = {
      client: id,
      label: host.label,
      file: read.file,
      configured: !!(read.found && read.entry && read.entry.command),
      stdioVerified: false,
      checks: []
    };
    if (read.unsupported) {
      item.error = read.unsupported;
      item.message = redact(read.file + ' 的 litejira 設定形狀無法解析（' + read.unsupported + '）。');
      report.clients.push(item);
      continue;
    }
    if (!item.configured) {
      item.error = 'not_configured';
      item.message = '在 ' + read.file + ' 找不到可用的 litejira 設定；請先跑 `litejira-mcp setup --client ' + id + '`。';
      report.clients.push(item);
      continue;
    }
    item.command = read.entry.command;
    item.args = Array.isArray(read.entry.args) ? read.entry.args : [];
    const verified = await verifyStdio(
      { command: item.command, args: item.args, env: read.entry.env },
      { timeoutMs: timeoutMs, redact: redact, baseEnv: baseEnv }
    );
    item.stdioVerified = verified.stdioVerified;
    item.serverVersion = verified.version;
    item.checks = verified.checks;
    report.clients.push(item);
  }

  report.ok = report.clients.length > 0 && report.clients.every(function (c) { return c.configured && c.stdioVerified; });
  return { code: report.ok ? 0 : 1, report: report };
}

function pickToken_(env) {
  const out = {};
  if (env.LTJ_API_TOKEN) out.LTJ_API_TOKEN = env.LTJ_API_TOKEN;
  if (env.LTJ_API_PAT) out.LTJ_API_PAT = env.LTJ_API_PAT;
  if (env.LTJ_API_URL) out.LTJ_API_URL = env.LTJ_API_URL;
  if (env.LTJ_PROJECT) out.LTJ_PROJECT = env.LTJ_PROJECT;
  return out;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  makeRedactor,
  runDoctor,
  verifyStdio
};
