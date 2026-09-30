'use strict';

// 真 stdio（spawn launcher）驗證 token-only 啟動路徑。
//
// 刻意不對外連線：所有斷言都落在「送出請求之前」就能判定的分支
// （啟動、tools/list、寫入開關、本機參數驗證、缺專案的本機報錯），
// 因此這支測試不會打到正式站。

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LAUNCHER = path.join(__dirname, '..', 'litejira-mcp-launch.cjs');
const TOKEN = 'ltj_pat_stdio_not_a_real_token';
const KEY = 'idem-key-token-only-1';

// 只留下必要的 OS 變數，確保測試不吃到開發者本機的 LTJ_* 設定與 ~/.litejira 憑證。
function cleanEnv(extra) {
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (key.indexOf('LTJ_') === 0) continue;
    env[key] = process.env[key];
  }
  env.LTJ_MCP_NO_UPDATE_CHECK = '1';
  // HOME / USERPROFILE 指到不存在的目錄 → launcher 找不到任何 credentials 檔。
  const fakeHome = path.join(__dirname, '__no_such_home__');
  env.HOME = fakeHome;
  env.USERPROFILE = fakeHome;
  return Object.assign(env, extra || {});
}

function startClient(env, args) {
  const child = spawn(process.execPath, [LAUNCHER].concat(args || []), {
    env: env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const pending = new Map();
  const stderr = [];
  const stdoutRaw = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', function (chunk) {
    stdoutRaw.push(chunk);
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === '') continue;
      const message = JSON.parse(line);   // stdout 出現非 JSON 就是污染，這裡會直接炸
      const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', function (chunk) { stderr.push(chunk); });

  let nextId = 0;
  return {
    stderr: stderr,
    stdoutRaw: stdoutRaw,
    call: function (method, params) {
      const id = ++nextId;
      return new Promise(function (resolve, reject) {
        const timer = setTimeout(function () {
          pending.delete(id);
          reject(new Error('stdio 逾時：' + method + '（stderr: ' + stderr.join('') + '）'));
        }, 10000);
        pending.set(id, function (message) { clearTimeout(timer); resolve(message); });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }) + '\n');
      });
    },
    stop: function () { child.kill(); }
  };
}

test('token-only 真 stdio：只有 PAT 也能啟動並列出工具，寫入預設開啟', async function (t) {
  const client = startClient(cleanEnv({ LTJ_API_TOKEN: TOKEN }));
  t.after(function () { client.stop(); });

  const init = await client.call('initialize', { protocolVersion: '2024-11-05' });
  assert.strictEqual(init.error, undefined, JSON.stringify(init.error));
  assert.strictEqual(init.result.serverInfo.version, require('../package.json').version);

  const tools = (await client.call('tools/list')).result.tools;
  assert.ok(tools.length > 0);

  // 寫入閘門在參數驗證之前 → 拿到 VALIDATION_FAILED 就證明「閘門是開的」，且完全沒有送出請求。
  const write = await client.call('tools/call', {
    name: 'litejira.addComment',
    arguments: { idempotencyKey: KEY }     // 故意缺必填欄位
  });
  assert.ok(write.error, '缺必填欄位應該報錯');
  assert.strictEqual(write.error.data.code, 'VALIDATION_FAILED',
    '未設 LTJ_MCP_ENABLE_WRITES 時寫入應預設開啟，不該是 WRITES_DISABLED');

  // stdout 只能有 JSON-RPC 行（上面的解析若遇到非 JSON 會直接丟例外）。
  for (const chunk of client.stdoutRaw) {
    assert.ok(chunk.indexOf('LiteJira MCP 設定') === -1, 'stdio 啟動不得有互動輸出');
  }
});

test('token-only 真 stdio：LTJ_MCP_ENABLE_WRITES=false 保留唯讀', async function (t) {
  const client = startClient(cleanEnv({ LTJ_API_TOKEN: TOKEN, LTJ_MCP_ENABLE_WRITES: 'false' }));
  t.after(function () { client.stop(); });

  await client.call('initialize', { protocolVersion: '2024-11-05' });
  const write = await client.call('tools/call', {
    name: 'litejira.addComment',
    arguments: { ticketId: 'BUG-1', body: 'hi', idempotencyKey: KEY }
  });
  assert.strictEqual(write.error.data.code, 'WRITES_DISABLED');
});

test('token-only 真 stdio：非法的寫入開關 fail closed 並在 stderr 警告', async function (t) {
  const client = startClient(cleanEnv({ LTJ_API_TOKEN: TOKEN, LTJ_MCP_ENABLE_WRITES: 'ture' }));
  t.after(function () { client.stop(); });

  await client.call('initialize', { protocolVersion: '2024-11-05' });
  const write = await client.call('tools/call', {
    name: 'litejira.addComment',
    arguments: { ticketId: 'BUG-1', body: 'hi', idempotencyKey: KEY }
  });
  assert.strictEqual(write.error.data.code, 'WRITES_DISABLED');
  assert.ok(/ture/.test(write.error.data.message || write.error.message),
    '錯誤訊息要點名那個打錯的值：' + JSON.stringify(write.error));
  assert.ok(/唯讀模式/.test(client.stderr.join('')), 'stderr 應有啟動警告：' + client.stderr.join(''));
});

// launcher 的 setup 分流：實際 spawn，確認它不會去啟動 MCP server。
function runLauncher(args, env) {
  return new Promise(function (resolve) {
    const child = spawn(process.execPath, [LAUNCHER].concat(args), {
      env: env || cleanEnv({}),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', function (c) { out += c; });
    child.stderr.on('data', function (c) { err += c; });
    child.stdin.end();
    child.on('exit', function (code) { resolve({ code: code, stdout: out, stderr: err }); });
  });
}

test('launcher 分流：--help 與 setup --help 直接輸出說明，不啟動 server', async function () {
  const help = await runLauncher(['--help']);
  assert.strictEqual(help.code, 0);
  assert.ok(/litejira-mcp setup/.test(help.stdout), help.stdout);

  const setupHelp = await runLauncher(['setup', '--help']);
  assert.strictEqual(setupHelp.code, 0);
  assert.ok(/litejira\.untaglab\.com/.test(setupHelp.stdout), setupHelp.stdout);
  assert.ok(/不要、也不應該貼進 AI 對話視窗|不需要、也不應該貼進 AI 對話視窗/.test(setupHelp.stdout), setupHelp.stdout);
});

// 非 TTY 不再是「拒絕」——AI 代跑是支援的路徑。但偵測不到任何 AI 主機時仍要明確失敗，
// 不能假裝註冊成功，也絕不能因此改去啟動 MCP server。
test('launcher 分流：偵測不到主機時 setup 明確失敗，不寫檔也不啟動 server', async function () {
  const result = await runLauncher(['setup'], cleanEnv({ LTJ_API_TOKEN: TOKEN }));
  assert.strictEqual(result.code, 2);
  assert.ok(/--client/.test(result.stderr), result.stderr);
  assert.ok(/未變更任何設定/.test(result.stderr), result.stderr);
  assert.strictEqual(result.stdout.indexOf('"jsonrpc"'), -1, '不該啟動 MCP server');
});

test('自訂站台（真 stdio）：沒設 LTJ_PROJECT 就明確報錯，不偷偷套 MAIN', async function (t) {
  const requests = [];
  const stub = http.createServer(function (req, res) {
    requests.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { items: [], nextCursor: null } }));
  });
  await new Promise(function (resolve) { stub.listen(0, '127.0.0.1', resolve); });
  const baseUrl = 'http://127.0.0.1:' + stub.address().port;

  const client = startClient(cleanEnv({ LTJ_API_TOKEN: TOKEN, LTJ_API_URL: baseUrl }));
  t.after(function () { client.stop(); stub.close(); });

  await client.call('initialize', { protocolVersion: '2024-11-05' });
  const search = await client.call('tools/call', {
    name: 'litejira.searchTickets',
    arguments: { limit: 5 }
  });
  assert.ok(search.error, '自訂站台沒有預設專案，應該報錯而不是猜一個');
  assert.ok(/project/i.test(JSON.stringify(search.error)));
  assert.strictEqual(requests.length, 0, '報錯前不該送出任何請求');

  // 明給 project 就能正常打出去（既有 precedence 不變）。
  const ok = await client.call('tools/call', {
    name: 'litejira.searchTickets',
    arguments: { project: 'CUSTOM', limit: 5 }
  });
  assert.strictEqual(ok.error, undefined, JSON.stringify(ok.error));
  assert.strictEqual(requests.length, 1);
  assert.ok(requests[0].indexOf('project=CUSTOM') !== -1, requests[0]);
});
