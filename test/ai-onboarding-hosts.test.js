'use strict';

// AI 代跑的安裝流程：把 litejira 註冊進 Codex / Claude Code / Gemini 的官方設定檔。
//
// 這一檔守的是「別把使用者的設定改壞」：其他 server 與不認得的設定必須原封不動、
// 舊的 litejira 項目要就地換掉（不能長出第二份）、檔案壞掉或形狀不認得時零變更。
//
// 全部在 mkdtemp 出來的假 home 下進行，絕不碰執行者真正的 ~/.codex、~/.claude.json、~/.gemini。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hosts = require('../litejira-hosts');
const toml = require('../litejira-toml-edit');

// 路徑一律走 path.resolve：Windows 上寫進設定檔的會是 C:\… 形式，斷言得跟著平台走。
const NODE_PATH = path.resolve('/usr/local/bin/node');
const LAUNCHER = path.resolve('/opt/litejira-mcp/litejira-mcp-launch.cjs');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ltj-home-'));
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

// ------------------------------------------------------------------ Codex --

test('Codex：舊的 litejira 項目就地換掉，其他區段（含子表、引號表頭、跨行陣列）原樣保留', function () {
  const home = tmpHome();
  const file = path.join(home, '.codex', 'config.toml');
  writeFile(file, [
    'model = "gpt-5"',
    '',
    '[mcp_servers.litejira]',
    'command = "litejira-mcp"',
    'args = []',
    '',
    '[mcp_servers.litejira.env]',
    'LTJ_API_URL = "https://script.google.com/macros/s/AKfycbxIDAs2fsZyyypMoDgbzI9PMcJFpGB0WwXZEj-mNg-CbWtOQay1if9jwvcnaDBsGI8b/exec"',
    'LTJ_PROJECT = "MAIN"',
    '',
    '[mcp_servers.other-dev-server]',
    'command = "node"',
    'args = [',
    '  "server.js",',
    '  "--flag"',
    ']',
    '',
    '[mcp_servers."weird name"]',
    'command = "weird"',
    'args = []',
    '',
    '[projects."/home/me/repo"]',
    'trust_level = "trusted"',
    ''
  ].join('\n'));

  const result = register(['codex'], home);
  const text = fs.readFileSync(file, 'utf8');

  assert.equal(result.results[0].files[0].status, 'replaced');
  // 只有一份 litejira 表 —— 不能長出重複別名
  assert.equal(text.match(/\[mcp_servers\.litejira\]/g).length, 1);
  assert.ok(text.indexOf('command = ' + JSON.stringify(NODE_PATH)) !== -1, text);
  assert.ok(text.indexOf('args = [' + JSON.stringify(LAUNCHER) + ']') !== -1, text);
  // 舊正式站網址（會讓新設定失效）清掉，其他 env 保留
  assert.equal(text.indexOf('script.google.com'), -1, '過期的舊正式站網址要清掉');
  assert.match(text, /LTJ_PROJECT = "MAIN"/);
  // 其他 server 與不相干設定完全不動
  assert.match(text, /\[mcp_servers\.other-dev-server\]/);
  assert.match(text, /"server\.js",/);
  assert.match(text, /\[mcp_servers\."weird name"\]/);
  assert.match(text, /\[projects\."\/home\/me\/repo"\]/);
  assert.match(text, /^model = "gpt-5"$/m);
  // 備份存在
  const backups = fs.readdirSync(path.dirname(file)).filter(function (n) { return n.indexOf('litejira-backup') !== -1; });
  assert.equal(backups.length, 1);
});

test('Codex：沒有設定檔時新建，重跑一次結果相同（idempotent）', function () {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const file = path.join(home, '.codex', 'config.toml');

  const first = register(['codex'], home);
  assert.equal(first.results[0].files[0].status, 'added');
  const afterFirst = fs.readFileSync(file, 'utf8');

  const second = register(['codex'], home);
  assert.equal(second.results[0].files[0].status, 'unchanged');
  assert.equal(fs.readFileSync(file, 'utf8'), afterFirst, '重跑不得改變檔案內容');
});

test('Codex：TOML 壞掉時零變更並回報可行動的原因', function () {
  const home = tmpHome();
  const file = path.join(home, '.codex', 'config.toml');
  const original = '[mcp_servers.litejira]\ncommand = "broken\n';
  writeFile(file, original);

  const result = register(['codex'], home);
  const entry = result.results[0].files[0];
  assert.equal(entry.status, 'blocked');
  assert.equal(entry.reason, 'malformed');
  assert.match(entry.message, /未做任何變更/);
  assert.equal(fs.readFileSync(file, 'utf8'), original, '壞檔一個位元組都不准動');
});

test('Codex：[[mcp_servers.litejira]] 這種不支援的形狀保守拒絕，不硬改', function () {
  const home = tmpHome();
  const file = path.join(home, '.codex', 'config.toml');
  const original = '[[mcp_servers.litejira]]\ncommand = "x"\n';
  writeFile(file, original);
  const entry = register(['codex'], home).results[0].files[0];
  assert.equal(entry.status, 'blocked');
  assert.equal(entry.reason, 'array_of_tables');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('Codex：多行字串裡長得像表頭的內容不得被當成表頭', function () {
  const home = tmpHome();
  const file = path.join(home, '.codex', 'config.toml');
  writeFile(file, [
    '[profile]',
    'notes = """',
    '[mcp_servers.litejira]',
    'command = "不是真的設定"',
    '"""',
    ''
  ].join('\n'));

  register(['codex'], home);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /notes = """/);
  assert.match(text, /command = "不是真的設定"/, '多行字串內容必須原樣保留');
  assert.ok(text.indexOf('command = ' + JSON.stringify(NODE_PATH)) !== -1, '真正的設定要另外附加');
});

// ----------------------------------------------------------------- Claude --

test('Claude Code：user 層寫入，其他 server 與設定保留；專案覆寫一併更新以免遮蔽', function () {
  const home = tmpHome();
  const cwd = path.join(home, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const file = path.join(home, '.claude.json');
  writeFile(file, JSON.stringify({
    numStartups: 7,
    mcpServers: {
      'my-dev-server': { command: 'node', args: ['dev.js'] },
      litejira: { command: 'litejira-mcp', args: [], env: { LTJ_API_TOKEN: 'leaked-token', KEEP_ME: '1' } }
    },
    projects: {
      [cwd]: { mcpServers: { litejira: { command: 'old', args: ['x'] } }, allowedTools: ['Bash'] }
    }
  }, null, 2));

  const result = register(['claude'], home);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));

  assert.equal(data.numStartups, 7, '不相干的設定必須保留');
  assert.deepEqual(data.mcpServers['my-dev-server'], { command: 'node', args: ['dev.js'] });
  assert.equal(data.mcpServers.litejira.command, NODE_PATH);
  assert.deepEqual(data.mcpServers.litejira.args, [LAUNCHER]);
  assert.equal(data.mcpServers.litejira.env.LTJ_API_TOKEN, undefined, '憑證不得留在主機設定檔');
  assert.equal(data.mcpServers.litejira.env.KEEP_ME, '1');
  assert.deepEqual(data.projects[cwd].allowedTools, ['Bash']);
  assert.equal(data.projects[cwd].mcpServers.litejira.command, NODE_PATH,
    '專案層覆寫沒更新的話，user 設定會被舊的遮蔽');
  const scopes = result.results[0].files.map(function (f) { return f.scope; });
  assert.ok(scopes.indexOf('project-local') !== -1);
});

test('Claude Code：.claude.json 不是合法 JSON 時零變更', function () {
  const home = tmpHome();
  const file = path.join(home, '.claude.json');
  const original = '{ "mcpServers": { }, }  // 尾逗號 + 註解';
  writeFile(file, original);
  const entry = register(['claude'], home).results[0].files[0];
  assert.equal(entry.status, 'blocked');
  assert.equal(entry.reason, 'malformed');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('Claude Code：專案 .mcp.json 既有的 litejira 項目一併更新，未定義時不新建', function () {
  const home = tmpHome();
  const cwd = path.join(home, 'workspace');
  writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }));
  const projectFile = path.join(cwd, '.mcp.json');
  writeFile(projectFile, JSON.stringify({ mcpServers: { litejira: { command: 'litejira-mcp' }, keep: { command: 'k' } } }, null, 2));

  register(['claude'], home);
  const data = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  assert.equal(data.mcpServers.litejira.command, NODE_PATH);
  assert.deepEqual(data.mcpServers.keep, { command: 'k' });

  // 沒有 litejira 的專案檔不該被建立或改動
  const home2 = tmpHome();
  const cwd2 = path.join(home2, 'workspace');
  fs.mkdirSync(cwd2, { recursive: true });
  writeFile(path.join(home2, '.claude.json'), JSON.stringify({ mcpServers: {} }));
  register(['claude'], home2);
  assert.equal(fs.existsSync(path.join(cwd2, '.mcp.json')), false);
});

test('Claude Code：被列入 disabledMcpjsonServers 時如實回報，不擅自改信任設定', function () {
  const home = tmpHome();
  const file = path.join(home, '.claude.json');
  writeFile(file, JSON.stringify({ mcpServers: {}, disabledMcpjsonServers: ['litejira'] }));
  const files = register(['claude'], home).results[0].files;
  const warning = files.find(function (f) { return f.status === 'warning'; });
  assert.ok(warning, '要回報主機已停用這個 server');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).disabledMcpjsonServers[0], 'litejira');
});

// ----------------------------------------------------------------- Gemini --

test('Gemini CLI：settings.json 就地更新，不相干設定保留', function () {
  const home = tmpHome();
  const file = path.join(home, '.gemini', 'settings.json');
  writeFile(file, JSON.stringify({
    theme: 'Dracula',
    mcpServers: { litejira: { command: 'litejira-mcp', env: { LTJ_API_PAT: 'leaked' } }, other: { command: 'o' } }
  }, null, 2));

  register(['gemini'], home);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.theme, 'Dracula');
  assert.deepEqual(data.mcpServers.other, { command: 'o' });
  assert.equal(data.mcpServers.litejira.command, NODE_PATH);
  assert.equal((data.mcpServers.litejira.env || {}).LTJ_API_PAT, undefined);
});

test('Gemini CLI：mcp.excluded / mcp.allowed 的管理者限制不繞過', function () {
  const home = tmpHome();
  const file = path.join(home, '.gemini', 'settings.json');
  const original = JSON.stringify({ mcp: { excluded: ['litejira'] }, mcpServers: {} }, null, 2);
  writeFile(file, original);
  const entry = register(['gemini'], home).results[0].files[0];
  assert.equal(entry.status, 'blocked');
  assert.equal(entry.reason, 'policy_excluded');
  assert.equal(fs.readFileSync(file, 'utf8'), original);

  const home2 = tmpHome();
  const file2 = path.join(home2, '.gemini', 'settings.json');
  writeFile(file2, JSON.stringify({ mcp: { allowed: ['something-else'] } }, null, 2));
  const entry2 = register(['gemini'], home2).results[0].files[0];
  assert.equal(entry2.reason, 'policy_not_allowed');
});

// --------------------------------------------------------------- 共用行為 --

test('偵測：只回報真的存在的主機目錄', function () {
  const home = tmpHome();
  assert.deepEqual(hosts.detectClients({ home: home, env: {}, cwd: home }), []);
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  assert.deepEqual(hosts.detectClients({ home: home, env: {}, cwd: home }), ['gemini']);
  fs.writeFileSync(path.join(home, '.claude.json'), '{}');
  assert.deepEqual(hosts.detectClients({ home: home, env: {}, cwd: home }).sort(), ['claude', 'gemini']);
});

test('CODEX_HOME 覆寫要被尊重', function () {
  const home = tmpHome();
  const custom = path.join(home, 'custom-codex');
  fs.mkdirSync(custom, { recursive: true });
  register(['codex'], home, { env: { CODEX_HOME: custom } });
  assert.ok(fs.existsSync(path.join(custom, 'config.toml')));
  assert.equal(fs.existsSync(path.join(home, '.codex', 'config.toml')), false);
});

test('啟動指令用 node 絕對路徑 + 套件內 launcher 絕對路徑（PATH 不可靠）', function () {
  const cmd = hosts.launchCommand({ execPath: path.resolve('/n/bin/node'), launcher: '/pkg/litejira-mcp-launch.cjs', target: 'dev' });
  assert.equal(cmd.command, path.resolve('/n/bin/node'));
  assert.deepEqual(cmd.args, [path.resolve('/pkg/litejira-mcp-launch.cjs'), 'dev']);
  const plain = hosts.launchCommand({});
  assert.equal(plain.command, process.execPath);
  assert.equal(path.basename(plain.args[0]), 'litejira-mcp-launch.cjs');
  assert.ok(path.isAbsolute(plain.args[0]));
  assert.equal(plain.args[0].indexOf('.litejira'), -1, '不得指向 ~/.litejira 下的舊路徑');
});

test('TOML 編輯：註解、inline table 與跨行 args 都判讀得出來', function () {
  const parsed = toml.readServerEntry('[mcp_servers]\nlitejira = { command = "x", env = { A = "1" } }\n', 'litejira');
  assert.equal(parsed.found, true);
  assert.deepEqual(parsed.entry.env, { A: '1' });

  const upserted = toml.upsertServerEntry(
    '[mcp_servers]\nlitejira = { command = "x" }\nother = { command = "o" }\n',
    'litejira',
    { command: 'node', args: ['a.js'], env: {} }
  );
  assert.equal(upserted.ok, true);
  assert.match(upserted.text, /other = \{ command = "o" \}/);
  assert.equal(upserted.text.match(/litejira/g).length, 1, '不得同時留下 inline 與表兩份設定');
});
