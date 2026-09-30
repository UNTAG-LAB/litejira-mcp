'use strict';

// setup / doctor 對呼叫端（多半是 AI）的契約：
//   * --json 的 stdout 是「一份可直接 JSON.parse 的輸出」，人看的進度走 stderr。
//   * 驗證時不得偷偷把 token 塞進子行程環境 —— 那會把「憑證沒存好」這種 bug 蓋掉。
//   * 既有憑證可以直接重新驗證，不必要求使用者再貼一次 PAT。
//   * 指令根本不存在時要「快速且明講」，不是等到逾時。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { runSetup } = require('../litejira-setup');
const { verifyStdio, makeRedactor } = require('../litejira-doctor');
const PKG_VERSION = require('../package.json').version;

const TOKEN = 'ltj_pat_contract_secret';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ltj-contract-'));
}

function collector() {
  const chunks = [];
  return { write: function (s) { chunks.push(s); return true; }, text: function () { return chunks.join(''); } };
}

function okFetch(seen) {
  return async function (url, init) {
    seen.push({
      url: String(url),
      auth: init && init.headers && (init.headers.Authorization || init.headers.authorization)
    });
    return { status: 200, text: async function () { return JSON.stringify({ data: { types: [] } }); } };
  };
}

// 假 server：會把「自己看到的環境」回報出來，讓我們驗得到 setup 有沒有偷塞 token。
function envReportingServer(dir) {
  const file = path.join(dir, 'env-server.js');
  fs.writeFileSync(file, [
    'const leaked = Object.keys(process.env).filter((k) => /^LTJ_/.test(k) && k !== "LTJ_MCP_ENABLE_WRITES" && k !== "LTJ_MCP_NO_UPDATE_CHECK");',
    'let buf = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => {',
    '  buf += chunk;',
    '  let nl;',
    '  while ((nl = buf.indexOf("\\n")) !== -1) {',
    '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
    '    if (!line.trim()) continue;',
    '    const msg = JSON.parse(line);',
    '    if (msg.id === undefined) continue;',
    '    if (leaked.length > 0) {',
    '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "leaked env: " + leaked.join(",") } }) + "\\n");',
    '      continue;',
    '    }',
    '    let result = {};',
    '    if (msg.method === "initialize") result = { serverInfo: { name: "litejira-mcp", version: ' + JSON.stringify(PKG_VERSION) + ' } };',
    '    if (msg.method === "tools/list") result = { tools: [{ name: "litejira.searchTickets" }] };',
    '    if (msg.method === "resources/read") result = { contents: [{ uri: msg.params.uri, text: "{}" }] };',
    '    if (msg.method === "tools/call") result = { structuredContent: { items: [] } };',
    '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");',
    '  }',
    '});',
    ''
  ].join('\n'), 'utf8');
  return file;
}

function baseOpts(home, extra) {
  return Object.assign({
    env: {},
    dir: path.join(home, '.litejira'),
    home: home,
    cwd: path.join(home, 'workspace'),
    stdout: collector(),
    stderr: collector(),
    stdin: Readable.from([Buffer.from(TOKEN + '\n', 'utf8')]),
    execPath: process.execPath,
    launcher: path.resolve('/opt/litejira-mcp/litejira-mcp-launch.cjs')
  }, extra || {});
}

test('--json：stdout 是單一份可直接 parse 的 JSON，進度訊息全部在 stderr', async function () {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const out = collector();
  const err = collector();

  const code = await runSetup(
    ['--client', 'codex', '--token-stdin', '--no-verify', '--json'],
    baseOpts(home, { stdout: out, stderr: err, fetch: okFetch([]) })
  );

  assert.equal(code, 0, err.text());
  const report = JSON.parse(out.text());          // 不切字串、不找第一個 {：整份就是 JSON
  assert.equal(report.ok, true);
  assert.equal(report.hostReloadRequired, true);
  assert.match(err.text(), /LiteJira MCP 設定/, '人看的進度要走 stderr');
  assert.equal(out.text().indexOf(TOKEN), -1);
  assert.equal(err.text().indexOf(TOKEN), -1, 'stderr 也不得出現 token');
});

test('啟動驗證不得把 token 偷塞進子行程：憑證得自己從檔案讀得到', async function () {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const server = envReportingServer(home);
  const err = collector();

  const code = await runSetup(
    ['--client', 'codex', '--token-stdin', '--json'],
    baseOpts(home, {
      // 這個 shell 有 LTJ_*：正是最容易讓驗證「自己餵答案」的情境。
      env: { LTJ_API_TOKEN: TOKEN, LTJ_PROJECT: 'MAIN' },
      stderr: err,
      launcher: server,
      fetch: okFetch([]),
      verifyTimeoutMs: 8000
    })
  );

  assert.equal(code, 0, err.text());
  assert.equal(err.text().indexOf('leaked env'), -1,
    '子行程看到 LTJ_* 就代表驗證環境被我們自己污染了：' + err.text());
});

test('shell 裡的自訂站台 / 專案會落地到憑證檔（否則 shell 一關設定就失效）', async function () {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const seen = [];

  const code = await runSetup(
    ['--client', 'codex', '--token-stdin', '--no-verify'],
    baseOpts(home, {
      env: { LTJ_API_URL: 'https://litejira.example.com/api', LTJ_PROJECT: 'OPS' },
      fetch: okFetch(seen)
    })
  );

  assert.equal(code, 0);
  const cred = fs.readFileSync(path.join(home, '.litejira', 'credentials.env'), 'utf8');
  assert.match(cred, /^LTJ_API_URL=https:\/\/litejira\.example\.com\/api$/m);
  assert.match(cred, /^LTJ_PROJECT=OPS$/m);
});

test('升級既有設定：本機已有憑證時不必要求使用者再貼一次 PAT', async function () {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const credFile = path.join(home, '.litejira', 'credentials.env');
  fs.mkdirSync(path.dirname(credFile), { recursive: true });
  fs.writeFileSync(credFile, 'LTJ_API_TOKEN=' + TOKEN + '\n', 'utf8');

  const out = collector();
  const seen = [];
  const code = await runSetup(
    ['--client', 'codex', '--no-verify', '--json'],
    baseOpts(home, {
      stdout: out,
      stdin: Readable.from([]),           // 非互動、沒有 stdin token、沒有環境變數
      fetch: okFetch(seen)
    })
  );

  const report = JSON.parse(out.text());
  assert.equal(code, 0, JSON.stringify(report, null, 2));
  assert.equal(report.tokenSource, 'existing');
  assert.equal(seen.length, 1, '既有 token 仍然要重新驗證過才算數');
  assert.equal(seen[0].auth, 'Bearer ' + TOKEN);
});

test('連 token 都沒有時才失敗，而且講得出下一步', async function () {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const err = collector();
  const code = await runSetup(
    ['--client', 'codex', '--no-verify'],
    baseOpts(home, { stderr: err, stdin: Readable.from([]), fetch: okFetch([]) })
  );
  assert.equal(code, 2);
  assert.match(err.text(), /--token-stdin/);
});

test('設定檔裡的指令根本不存在 → 快速失敗並說得出是啟動不了，不是等到逾時', async function () {
  const started = Date.now();
  const result = await verifyStdio(
    { command: path.join(tmpDir(), 'definitely-not-here'), args: [] },
    { timeoutMs: 20000, redact: makeRedactor([]), baseEnv: {} }
  );
  const elapsed = Date.now() - started;
  assert.equal(result.stdioVerified, false);
  assert.ok(elapsed < 10000, 'ENOENT 不該拖到逾時才回報（實際 ' + elapsed + 'ms）');
  const failure = result.checks.find(function (c) { return !c.ok; });
  assert.match(failure.detail, /無法啟動|ENOENT/);
});
