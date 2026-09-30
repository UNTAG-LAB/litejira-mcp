'use strict';

// 政策欄位不得被我們吃掉。
//
// 這一檔守的是比「別寫壞檔案」更細的一層：使用者或管理者在主機設定裡表達的**限制**
// （停用、工具白/黑名單、trust、逾時、我們不認得的任何鍵）都不是我們可以順手清掉的東西。
// 接手 litejira 的「啟動方式」是我們的事；「要不要跑、能跑哪些工具」不是。
//
// 全部在 mkdtemp 出來的假 home 下進行，絕不碰執行者真正的 ~/.codex、~/.claude.json、~/.gemini。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hosts = require('../litejira-hosts');

const NODE_PATH = path.resolve('/usr/local/bin/node');
const LAUNCHER = path.resolve('/opt/litejira-mcp/litejira-mcp-launch.cjs');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ltj-policy-'));
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function register(clients, home, extra) {
  return hosts.registerClients(clients, Object.assign({
    home: home,
    cwd: path.join(home, 'workspace'),
    env: {},
    execPath: NODE_PATH,
    launcher: LAUNCHER
  }, extra || {}));
}

test('Codex：enabled / 工具限制 / 逾時 / 未知鍵與註解全部保留，只有啟動方式被接手', function () {
  const home = tmpHome();
  const file = path.join(home, '.codex', 'config.toml');
  writeFile(file, [
    '[mcp_servers.litejira]',
    '# 這個 server 暫時關著，等安全審查過再開',
    'enabled = false',
    'command = "litejira-mcp"',
    'args = ["old"]',
    'url = "https://example.invalid/sse"',
    'startup_timeout_sec = 30',
    'enabled_tools = ["litejira.searchTickets"]',
    'disabled_tools = ["litejira.createTicket"]',
    'some_future_key = "keep me"',
    '',
    '[mcp_servers.litejira.tools]',
    'approval_mode = "never"',
    '',
    '[mcp_servers.litejira.env]',
    'LTJ_API_TOKEN = "leaked-token-value"',
    'LTJ_PROJECT = "MAIN"',
    ''
  ].join('\n'));

  const result = register(['codex'], home);
  const text = fs.readFileSync(file, 'utf8');

  assert.match(text, /enabled = false/, 'enabled=false 不得被吃掉（那等於擅自啟用）');
  assert.match(text, /# 這個 server 暫時關著/, '註解要留著');
  assert.match(text, /startup_timeout_sec = 30/);
  assert.match(text, /enabled_tools = \["litejira\.searchTickets"\]/);
  assert.match(text, /disabled_tools = \["litejira\.createTicket"\]/);
  assert.match(text, /some_future_key = "keep me"/, '不認得的鍵也要原樣保留');
  assert.match(text, /\[mcp_servers\.litejira\.tools\]\napproval_mode = "never"/);
  assert.match(text, /LTJ_PROJECT = "MAIN"/);
  assert.equal(text.includes('LTJ_API_TOKEN'), false, '憑證要清掉');
  assert.equal(/^url = /m.test(text), false, '與 stdio 互斥的舊傳輸欄位要清掉');
  assert.ok(text.includes('command = ' + JSON.stringify(NODE_PATH)), '啟動指令要換成我們的');

  const policy = result.results[0].files.find(function (f) { return f.reason === 'disabled'; });
  assert.ok(policy, '被停用時要如實回報，不能當成單純成功');
  assert.equal(policy.policyDisabled, true);
});

test('Codex：inline table 轉表時，政策鍵一樣要跟著搬過去', function () {
  const home = tmpHome();
  const file = path.join(home, '.codex', 'config.toml');
  writeFile(file, [
    '[mcp_servers]',
    'litejira = { command = "old", enabled = false, enabled_tools = ["a"], env = { LTJ_API_PAT = "leaked-token", KEEP = "1" } }',
    'other = { command = "o" }',
    ''
  ].join('\n'));

  register(['codex'], home);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /other = \{ command = "o" \}/);
  assert.match(text, /enabled = false/);
  assert.match(text, /enabled_tools = \["a"\]/);
  assert.match(text, /KEEP = "1"/);
  assert.equal(text.includes('LTJ_API_PAT'), false);
  assert.equal(/^litejira = /m.test(text), false, '不得同時留下 inline 與表兩份設定');
  assert.equal((text.match(/^\[mcp_servers\.litejira\]$/gm) || []).length, 1);
});

test('Codex preflight：重複表頭 / 重複鍵 / 不成形的值一律擋下並零變更', function () {
  const cases = [
    ['[mcp_servers.litejira]\ncommand = "a"\n\n[mcp_servers.litejira]\ncommand = "b"\n', '重複表頭'],
    ['[mcp_servers.litejira]\ncommand = "a"\ncommand = "b"\n', '重複鍵'],
    ['[mcp_servers.litejira]\ncommand = @@@\n', '不成形的值'],
    ['[mcp_servers.litejira]\ncommand =\n', '缺值']
  ];
  for (const pair of cases) {
    const home = tmpHome();
    const file = path.join(home, '.codex', 'config.toml');
    writeFile(file, pair[0]);
    const entry = register(['codex'], home).results[0].files[0];
    assert.equal(entry.status, 'blocked', pair[1] + ' 應該被擋下');
    assert.equal(entry.reason, 'malformed', pair[1]);
    assert.equal(fs.readFileSync(file, 'utf8'), pair[0], pair[1] + ' 必須零變更');
  }
});

test('Gemini：includeTools / excludeTools / trust 等既有設定不得被覆蓋掉', function () {
  const home = tmpHome();
  const file = path.join(home, '.gemini', 'settings.json');
  writeFile(file, JSON.stringify({
    mcpServers: {
      litejira: {
        command: 'litejira-mcp',
        url: 'https://example.invalid/sse',
        includeTools: ['litejira.searchTickets'],
        excludeTools: ['litejira.createTicket'],
        trust: false,
        timeout: 15000,
        env: { LTJ_API_TOKEN: 'leaked-token-value', LTJ_PROJECT: 'MAIN' }
      }
    }
  }, null, 2));

  register(['gemini'], home);
  const entry = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.litejira;
  assert.deepEqual(entry.includeTools, ['litejira.searchTickets']);
  assert.deepEqual(entry.excludeTools, ['litejira.createTicket']);
  assert.equal(entry.trust, false, 'trust=false 不得被我們改成 true');
  assert.equal(entry.timeout, 15000);
  assert.equal(entry.url, undefined, '與 stdio 互斥的傳輸欄位要拿掉');
  assert.equal(entry.env.LTJ_API_TOKEN, undefined);
  assert.equal(entry.env.LTJ_PROJECT, 'MAIN');
  assert.equal(entry.command, NODE_PATH);
});

test('Claude：local / project 既有項目的其他鍵保留，讀回來走主機真正的優先序', function () {
  const home = tmpHome();
  const cwd = path.join(home, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const userFile = path.join(home, '.claude.json');
  const projects = {};
  projects[cwd] = {
    mcpServers: { litejira: { command: 'old-local', env: { LTJ_API_TOKEN: 'leaked-token-value' }, disabled: true } },
    disabledMcpjsonServers: ['litejira']
  };
  writeFile(userFile, JSON.stringify({
    mcpServers: { litejira: { command: 'old', type: 'stdio', disabled: true } },
    projects: projects
  }, null, 2));
  writeFile(path.join(cwd, '.mcp.json'), JSON.stringify({
    mcpServers: { litejira: { command: 'old-project' } }
  }, null, 2));

  const result = hosts.registerClients(['claude'], {
    home: home, cwd: cwd, env: {}, execPath: NODE_PATH, launcher: LAUNCHER
  });
  const data = JSON.parse(fs.readFileSync(userFile, 'utf8'));
  assert.equal(data.mcpServers.litejira.disabled, true, 'disabled 是使用者的決定，不得被清掉');
  assert.equal(data.mcpServers.litejira.type, undefined, '傳輸欄位要拿掉');
  assert.equal(data.projects[cwd].mcpServers.litejira.disabled, true);
  assert.equal((data.projects[cwd].mcpServers.litejira.env || {}).LTJ_API_TOKEN, undefined);

  const policy = result.results[0].files.find(function (f) { return f.reason === 'disabled'; });
  assert.ok(policy, 'projects[cwd].disabledMcpjsonServers 也要看得到');

  // 優先序：local（projects[cwd]）> project（.mcp.json）> user。
  const read = hosts.HOSTS.claude.read(hosts.makeContext({ home: home, cwd: cwd, env: {} }));
  assert.equal(read.scope, 'local');
  assert.equal(read.file, userFile);
  assert.equal(read.entry.command, NODE_PATH);
});

test('Claude：沒有 local 覆寫時，讀回來的是專案 .mcp.json 而不是 user', function () {
  const home = tmpHome();
  const cwd = path.join(home, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { litejira: { command: 'user' } } }, null, 2));
  writeFile(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { litejira: { command: 'project' } } }, null, 2));
  const read = hosts.HOSTS.claude.read(hosts.makeContext({ home: home, cwd: cwd, env: {} }));
  assert.equal(read.scope, 'project');
  assert.equal(read.entry.command, 'project');
});

test('CLAUDE_CONFIG_DIR 是設定目錄、GEMINI_CLI_HOME 是 HOME（不是設定目錄）', function () {
  const home = tmpHome();
  const configDir = path.join(home, 'alt-config');
  const geminiRoot = path.join(home, 'alt-home');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(geminiRoot, { recursive: true });

  register(['claude'], home, { env: { CLAUDE_CONFIG_DIR: configDir } });
  assert.ok(fs.existsSync(path.join(configDir, '.claude.json')), 'CLAUDE_CONFIG_DIR/.claude.json');
  assert.equal(fs.existsSync(path.join(home, '.claude.json')), false);

  register(['gemini'], home, { env: { GEMINI_CLI_HOME: geminiRoot } });
  assert.ok(fs.existsSync(path.join(geminiRoot, '.gemini', 'settings.json')), 'GEMINI_CLI_HOME/.gemini/settings.json');
  assert.equal(fs.existsSync(path.join(home, '.gemini', 'settings.json')), false);
});
