'use strict';

// `litejira-mcp doctor`：讀主機設定檔裡**實際寫的**那條 command/args 並真的啟動它。
//
// 這一檔用假的 MCP server 腳本模擬各種壞掉的方式（版本對不上、掛住不回、啟動就死），
// 確認 doctor 一律誠實回報而不是宣稱成功；也確認它只敢說「設定寫好了」，
// 不會宣稱 AI 主機已經載入（那不是我們控制得了的事）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runDoctor, verifyStdio, makeRedactor } = require('../litejira-doctor');
const PKG_VERSION = require('../package.json').version;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ltj-doctor-'));
}

// 一支可設定行為的假 MCP server：照 JSON-RPC 逐行回應。
function fakeServer(dir, opts) {
  const options = Object.assign({ version: PKG_VERSION, hang: false, die: false }, opts || {});
  const file = path.join(dir, 'fake-server.js');
  fs.writeFileSync(file, [
    'const options = ' + JSON.stringify(options) + ';',
    'if (options.die) { process.stderr.write("boom: token=" + (process.env.LTJ_API_TOKEN || "") + "\\n"); process.exit(3); }',
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
    '    if (options.hang) continue;',
    '    let result = {};',
    '    if (msg.method === "initialize") result = { serverInfo: { name: "litejira-mcp", version: options.version } };',
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

function writeCodexConfig(home, command, args) {
  const file = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '[mcp_servers.litejira]',
    'command = ' + JSON.stringify(command),
    'args = [' + args.map(function (a) { return JSON.stringify(a); }).join(', ') + ']',
    ''
  ].join('\n'), 'utf8');
  return file;
}

test('設定檔裡那條指令起得來且版本相符 → stdioVerified，但不宣稱主機已載入', async function () {
  const home = tmpDir();
  const server = fakeServer(home, {});
  writeCodexConfig(home, process.execPath, [server]);

  const result = await runDoctor(['--client', 'codex'], { home: home, env: {}, dir: path.join(home, '.litejira'), timeoutMs: 8000 });
  assert.equal(result.code, 0, JSON.stringify(result.report, null, 2));
  const client = result.report.clients[0];
  assert.equal(client.configured, true);
  assert.equal(client.stdioVerified, true);
  assert.equal(client.serverVersion, PKG_VERSION);
  assert.equal(result.report.hostReloadRequired, true, 'doctor 不得宣稱 AI 主機已經重載設定');
  assert.match(result.report.hostReloadNote, /重連|重啟/);
  // 讀的是設定檔裡實際寫的指令
  assert.equal(client.command, process.execPath);
  assert.deepEqual(client.args, [server]);
});

test('版本對不上（設定指向舊安裝）→ 明確失敗', async function () {
  const home = tmpDir();
  const server = fakeServer(home, { version: '0.0.1-old' });
  writeCodexConfig(home, process.execPath, [server]);

  const result = await runDoctor(['--client', 'codex'], { home: home, env: {}, dir: path.join(home, '.litejira'), timeoutMs: 8000 });
  assert.equal(result.code, 1);
  const client = result.report.clients[0];
  assert.equal(client.stdioVerified, false);
  const mismatch = client.checks.find(function (c) { return c.name === 'versionMatch'; });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.detail, /0\.0\.1-old/);
});

test('掛住不回 → 有界逾時後失敗，不會卡住', async function () {
  const home = tmpDir();
  const server = fakeServer(home, { hang: true });
  writeCodexConfig(home, process.execPath, [server]);

  const started = Date.now();
  const result = await runDoctor(['--client', 'codex'], { home: home, env: {}, dir: path.join(home, '.litejira'), timeoutMs: 600 });
  assert.equal(result.code, 1);
  assert.ok(Date.now() - started < 8000, 'timeout 必須有上界');
  assert.equal(result.report.clients[0].stdioVerified, false);
  assert.match(JSON.stringify(result.report), /逾時/);
});

test('子行程一啟動就死 → 失敗，且 stderr 裡的憑證被遮蔽', async function () {
  const home = tmpDir();
  const server = fakeServer(home, { die: true });
  writeCodexConfig(home, process.execPath, [server]);
  const token = 'ltj_pat_should_be_redacted';
  fs.mkdirSync(path.join(home, '.litejira'), { recursive: true });
  fs.writeFileSync(path.join(home, '.litejira', 'credentials.env'), 'LTJ_API_TOKEN=' + token + '\n', 'utf8');

  const result = await runDoctor(['--client', 'codex'], { home: home, env: {}, dir: path.join(home, '.litejira'), timeoutMs: 5000 });
  assert.equal(result.code, 1);
  assert.equal(result.report.clients[0].stdioVerified, false);
  const serialized = JSON.stringify(result.report);
  assert.equal(serialized.indexOf(token), -1, '子行程 stderr 裡的 token 必須被遮蔽');
});

test('主機沒設定過 litejira → configured=false，並指向該跑哪個指令', async function () {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const result = await runDoctor(['--client', 'codex'], { home: home, env: {}, dir: path.join(home, '.litejira') });
  assert.equal(result.code, 1);
  assert.equal(result.report.clients[0].configured, false);
  assert.match(result.report.clients[0].message, /setup --client codex/);
});

test('偵測不到任何主機 → 明確失敗而不是空過', async function () {
  const home = tmpDir();
  const result = await runDoctor([], { home: home, env: {}, dir: path.join(home, '.litejira') });
  assert.equal(result.code, 2);
  assert.equal(result.report.ok, false);
  assert.equal(result.report.error, 'no_host_detected');
});

test('redactor：長度足夠的祕密一律換掉，短字串不誤傷', function () {
  const redact = makeRedactor(['supersecrettoken', '', 'ab']);
  assert.equal(redact('前 supersecrettoken 後'), '前 *** 後');
  assert.equal(redact('ab'), 'ab');
});

test('verifyStdio 直接被呼叫時也一樣唯讀且有界', async function () {
  const home = tmpDir();
  const server = fakeServer(home, {});
  const verified = await verifyStdio(
    { command: process.execPath, args: [server], env: {} },
    { timeoutMs: 5000, baseEnv: {} }
  );
  assert.equal(verified.stdioVerified, true);
  assert.equal(verified.checks.some(function (c) { return c.name === 'tools/call litejira.searchTickets'; }), true);
});
