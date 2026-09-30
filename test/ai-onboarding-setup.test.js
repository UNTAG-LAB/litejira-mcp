'use strict';

// 端到端（不含真站台）的 AI 安裝流程：`setup --client … --token-stdin`。
//
// 重點是「失敗時什麼都不要發生」：token 驗不過、主機設定檔壞掉、偵測不到主機，
// 都必須零變更且講得出原因；成功時 token 只進 0600 的憑證檔，絕不出現在設定檔或輸出。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { runSetup } = require('../litejira-setup');

const TOKEN = 'ltj_pat_ai_flow_secret';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function collector() {
  const chunks = [];
  return { write: function (s) { chunks.push(s); return true; }, text: function () { return chunks.join(''); } };
}

function stdinWith(text) {
  return Readable.from([Buffer.from(text, 'utf8')]);
}

function okFetch(seen) {
  return async function (url, init) {
    seen.push({ url: String(url), auth: init && init.headers && (init.headers.Authorization || init.headers.authorization) });
    return { status: 200, text: async function () { return JSON.stringify({ data: { types: [] } }); } };
  };
}

function failFetch() {
  return async function () {
    return { status: 401, text: async function () { return JSON.stringify({ error: { code: 'unauthenticated', message: 'bad token' } }); } };
  };
}

function baseOpts(home, extra) {
  const dir = path.join(home, '.litejira');
  return Object.assign({
    env: {},
    dir: dir,
    home: home,
    cwd: path.join(home, 'workspace'),
    stdout: collector(),
    stderr: collector(),
    stdin: stdinWith(TOKEN + '\n'),
    execPath: path.resolve('/usr/bin/node'),
    launcher: path.resolve('/opt/litejira-mcp/litejira-mcp-launch.cjs'),
    verify: false
  }, extra || {});
}

test('非互動主線：--client codex --token-stdin 一次完成憑證與註冊', async function () {
  const home = tmpDir('ltj-flow-');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const out = collector();
  const err = collector();
  const seen = [];
  const code = await runSetup(
    ['--client', 'codex', '--token-stdin', '--no-verify', '--json'],
    baseOpts(home, { stdout: out, stderr: err, fetch: okFetch(seen) })
  );

  assert.equal(code, 0, err.text());
  const cred = fs.readFileSync(path.join(home, '.litejira', 'credentials.env'), 'utf8');
  assert.match(cred, new RegExp('^LTJ_API_TOKEN=' + TOKEN + '$', 'm'));
  const config = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(config, /\[mcp_servers\.litejira\]/);
  assert.equal(config.indexOf(TOKEN), -1, '憑證不得寫進主機設定檔');
  assert.equal(out.text().indexOf(TOKEN), -1, 'token 不得出現在 stdout');
  assert.equal(err.text().indexOf(TOKEN), -1, 'token 不得出現在 stderr');
  // 驗證打的是新正式站
  assert.match(seen[0].url, /^https:\/\/litejira\.untaglab\.com\//);
  const report = JSON.parse(out.text().slice(out.text().indexOf('{')));
  assert.equal(report.ok, true);
  assert.equal(report.clients[0].configured, true);
  assert.equal(report.hostReloadRequired, true, '不得宣稱主機已載入新設定');
  assert.equal(JSON.stringify(report).indexOf(TOKEN), -1);
});

test('舊的 Codex 設定（screenshot 那種）被換成目前套件的啟動指令', async function () {
  const home = tmpDir('ltj-flow-');
  const file = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '[mcp_servers.litejira]',
    'command = "node"',
    'args = ["' + path.join(home, '.litejira', 'mcp', 'index.js').replace(/\\/g, '\\\\') + '"]',
    ''
  ].join('\n'), 'utf8');

  const code = await runSetup(
    ['--client', 'codex', '--token-stdin', '--no-verify'],
    baseOpts(home, { fetch: okFetch([]) })
  );
  assert.equal(code, 0);
  const config = fs.readFileSync(file, 'utf8');
  assert.equal(config.indexOf('.litejira' + path.sep + 'mcp'), -1, '舊的 ~/.litejira/mcp 路徑必須消失');
  assert.equal(config.match(/\[mcp_servers\.litejira\]/g).length, 1);
  assert.ok(config.indexOf(JSON.stringify(path.resolve('/opt/litejira-mcp/litejira-mcp-launch.cjs'))) !== -1);
});

test('token 驗證失敗：憑證與主機設定都不動', async function () {
  const home = tmpDir('ltj-flow-');
  const file = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = '[mcp_servers.litejira]\ncommand = "litejira-mcp"\nargs = []\n';
  fs.writeFileSync(file, original, 'utf8');
  const err = collector();

  const code = await runSetup(
    ['--client', 'codex', '--token-stdin'],
    baseOpts(home, { stderr: err, fetch: failFetch() })
  );
  assert.equal(code, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), original, '驗證失敗不得改動主機設定');
  assert.equal(fs.existsSync(path.join(home, '.litejira', 'credentials.env')), false);
  assert.match(err.text(), /未變更任何憑證/);
  assert.equal(err.text().indexOf(TOKEN), -1);
});

test('主機設定檔壞掉：preflight 就停下來，連憑證都不寫', async function () {
  const home = tmpDir('ltj-flow-');
  const file = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = '[mcp_servers.litejira]\ncommand = "壞掉\n';
  fs.writeFileSync(file, original, 'utf8');
  const err = collector();
  let fetched = false;

  const code = await runSetup(
    ['--client', 'codex', '--token-stdin'],
    baseOpts(home, { stderr: err, fetch: async function () { fetched = true; throw new Error('不該驗證'); } })
  );
  assert.equal(code, 3);
  assert.equal(fetched, false, 'preflight 沒過就不該拿 token 去打 API');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(home, '.litejira', 'credentials.env')), false);
  assert.match(err.text(), /未做任何變更/);
});

test('auto 偵測不到任何主機：明確失敗，不假裝成功', async function () {
  const home = tmpDir('ltj-flow-');
  const err = collector();
  const code = await runSetup(
    ['--token-stdin'],
    baseOpts(home, { stderr: err, fetch: async function () { throw new Error('不該驗證'); } })
  );
  assert.equal(code, 2);
  assert.match(err.text(), /--client/);
  assert.equal(fs.existsSync(path.join(home, '.litejira')), false);
});

test('重跑一次是 idempotent：不長出第二份設定，內容不變', async function () {
  const home = tmpDir('ltj-flow-');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const file = path.join(home, '.codex', 'config.toml');
  await runSetup(['--client', 'codex', '--token-stdin', '--no-verify'], baseOpts(home, { fetch: okFetch([]) }));
  const first = fs.readFileSync(file, 'utf8');
  await runSetup(['--client', 'codex', '--token-stdin', '--no-verify'], baseOpts(home, { fetch: okFetch([]) }));
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  assert.equal(first.match(/\[mcp_servers\.litejira\]/g).length, 1);
});

test('環境變數也算合法的非互動 token 來源', async function () {
  const home = tmpDir('ltj-flow-');
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  const out = collector();
  const code = await runSetup(
    ['--client', 'gemini', '--no-verify'],
    baseOpts(home, { env: { LTJ_API_TOKEN: TOKEN }, stdin: stdinWith(''), stdout: out, fetch: okFetch([]) })
  );
  assert.equal(code, 0);
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'));
  assert.ok(settings.mcpServers.litejira.command);
  assert.equal(out.text().indexOf(TOKEN), -1);
});

test('--token-stdin 有長度上限：餵一整包東西進來會被擋下且零變更', async function () {
  const home = tmpDir('ltj-flow-');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const err = collector();
  const code = await runSetup(
    ['--client', 'codex', '--token-stdin'],
    baseOpts(home, { stdin: stdinWith('x'.repeat(9000)), stderr: err, fetch: async function () { throw new Error('不該驗證'); } })
  );
  assert.equal(code, 2);
  assert.match(err.text(), /位元組/);
  assert.equal(fs.existsSync(path.join(home, '.litejira', 'credentials.env')), false);
});

test('setup 的啟動驗證跑的是寫進設定檔的那條指令，並誠實標記主機仍需重載', async function () {
  const home = tmpDir('ltj-flow-');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  // 把 launcher 換成一支假的 MCP server：驗證這一步真的會去啟動設定檔裡那條指令。
  const fake = path.join(home, 'fake-server.js');
  fs.writeFileSync(fake, [
    'const VERSION = ' + JSON.stringify(require('../package.json').version) + ';',
    'let buf = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => {',
    '  buf += chunk; let nl;',
    '  while ((nl = buf.indexOf("\\n")) !== -1) {',
    '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
    '    if (!line.trim()) continue;',
    '    const msg = JSON.parse(line); if (msg.id === undefined) continue;',
    '    let result = {};',
    '    if (msg.method === "initialize") result = { serverInfo: { version: VERSION } };',
    '    if (msg.method === "tools/list") result = { tools: [{ name: "litejira.searchTickets" }] };',
    '    if (msg.method === "resources/read") result = { contents: [{ text: "{}" }] };',
    '    if (msg.method === "tools/call") result = { structuredContent: { items: [] } };',
    '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");',
    '  }',
    '});',
    ''
  ].join('\n'), 'utf8');

  const out = collector();
  const code = await runSetup(
    ['--client', 'codex', '--token-stdin', '--json'],
    baseOpts(home, { stdout: out, execPath: process.execPath, launcher: fake, verifyTimeoutMs: 8000, fetch: okFetch([]) })
  );
  assert.equal(code, 0, out.text());
  const report = JSON.parse(out.text().slice(out.text().indexOf('{')));
  assert.equal(report.clients[0].stdioVerified, true);
  assert.equal(report.hostReloadRequired, true, '不得因為自己啟得起來就宣稱主機已載入');
  assert.equal(JSON.stringify(report).indexOf(TOKEN), -1);
});

test('不認得的 --client 直接拒絕', async function () {
  const home = tmpDir('ltj-flow-');
  const err = collector();
  const code = await runSetup(['--client', 'cursor', '--token-stdin'], baseOpts(home, { stderr: err }));
  assert.equal(code, 2);
  assert.match(err.text(), /codex/);
});
