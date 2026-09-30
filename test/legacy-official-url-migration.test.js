'use strict';

// 3.1.0 升級後的回歸：credentials 檔還留著已退役的舊正式站（Apps Script）網址時，
//   * 不該因為「不是正式站」而在問 token 之前就要求 LTJ_PROJECT（原本 setup 直接 exit 2）；
//   * 實際連線要走新正式站，launcher / server / CLI 都一樣；
//   * 但遷移只對 allowlist 內的 deployment 成立 —— 別人自架的 GAS 站台不得被改寫。
// 全部用假 token 與 mock fetch，不連任何真實站台。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

const {
  LEGACY_OFFICIAL_API_URLS,
  OFFICIAL_API_URL,
  OFFICIAL_DEFAULT_PROJECT,
  applyDefaults,
  isLegacyOfficialUrl,
  resolveSettings,
  unquoteValue
} = require('../litejira-config');
const { getConfigFromEnv, callTool } = require('../litejira-mcp-server');
const { runSetup } = require('../litejira-setup');
const { runCli } = require('../ltj-cli');

const LEGACY_URL = LEGACY_OFFICIAL_API_URLS[0];
const OTHER_GAS_URL = 'https://script.google.com/macros/s/AKfycbxSOMEONEELSEDEPLOYMENTID000000000000000/exec';
const TOKEN = 'ltj_pat_fake_for_tests';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ltj-legacy-'));
}

function collector() {
  const chunks = [];
  return { write: function (s) { chunks.push(s); return true; }, text: function () { return chunks.join(''); } };
}

// 假 TTY：把要「打」的字元一次餵進 data 事件（含結尾 Enter 或 Ctrl+C）。
function fakeStdin(keystrokes) {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = function (v) { stdin.isRaw = v; };
  stdin.resume = function () {};
  stdin.pause = function () {};
  stdin.setEncoding = function () {};
  stdin.removeListener = EventEmitter.prototype.removeListener.bind(stdin);
  const origOn = stdin.on.bind(stdin);
  stdin.on = function (event, handler) {
    origOn(event, handler);
    if (event === 'data') setImmediate(function () { stdin.emit('data', keystrokes); });
    return stdin;
  };
  return stdin;
}

function okFetch(seen) {
  return async function (url) {
    seen.push(String(url));
    return { status: 200, text: async function () { return JSON.stringify({ data: { types: [], statuses: [] } }); } };
  };
}

test('舊正式站網址：解析成新正式站，並套用預設專案 MAIN', function () {
  const settings = resolveSettings({ LTJ_API_TOKEN: TOKEN, LTJ_API_URL: LEGACY_URL });
  assert.equal(settings.apiUrl, OFFICIAL_API_URL);
  assert.equal(settings.apiUrlSource, 'migrated');
  assert.equal(settings.migratedFromLegacy, true);
  assert.equal(settings.legacyApiUrl, LEGACY_URL);
  assert.equal(settings.isOfficial, true);
  assert.equal(settings.project, OFFICIAL_DEFAULT_PROJECT, '舊正式站等同正式站，沒給專案要補 MAIN');
  assert.equal(settings.projectSource, 'default');

  // 結尾斜線只是寫法差異，仍是同一個 deployment。
  assert.equal(isLegacyOfficialUrl(LEGACY_URL + '/'), true);
});

test('舊正式站網址＋明給 project / 寫入關閉：既有設定照樣優先', function () {
  const settings = resolveSettings({
    LTJ_API_TOKEN: TOKEN,
    LTJ_API_URL: LEGACY_URL,
    LTJ_PROJECT: 'OTHER',
    LTJ_MCP_ENABLE_WRITES: 'false'
  });
  assert.equal(settings.apiUrl, OFFICIAL_API_URL);
  assert.equal(settings.project, 'OTHER');
  assert.equal(settings.projectSource, 'env');
  assert.equal(settings.enableWrites, false);
});

test('不在 allowlist 的 GAS 網址不遷移，只標記出來', function () {
  const settings = resolveSettings({ LTJ_API_TOKEN: TOKEN, LTJ_API_URL: OTHER_GAS_URL });
  assert.equal(settings.apiUrl, OTHER_GAS_URL, '別人的 Apps Script 部署不得被改寫成我們的正式站');
  assert.equal(settings.apiUrlSource, 'env');
  assert.equal(settings.migratedFromLegacy, false);
  assert.equal(settings.isUnknownLegacyGas, true);
  assert.equal(settings.project, '', '不認得的站台不猜專案');

  // host 對、path 不對 → 不算；host 不對 → 更不算。
  assert.equal(isLegacyOfficialUrl(OTHER_GAS_URL), false);
  assert.equal(isLegacyOfficialUrl(LEGACY_URL.replace('script.google.com', 'script.evil.test')), false);
  assert.equal(isLegacyOfficialUrl(LEGACY_URL.replace('https://', 'http://')), false);
});

test('一般自訂站台完全不受影響', function () {
  const settings = resolveSettings({ LTJ_API_TOKEN: TOKEN, LTJ_API_URL: 'https://jira.internal.example' });
  assert.equal(settings.apiUrl, 'https://jira.internal.example');
  assert.equal(settings.apiUrlSource, 'env');
  assert.equal(settings.migratedFromLegacy, false);
  assert.equal(settings.isUnknownLegacyGas, false);
  assert.equal(settings.project, '');
});

test('值兩側成對的引號會被脫掉：舊正式站認得出來、自訂站台也不會被誤判', function () {
  assert.equal(unquoteValue('"https://x.example"'), 'https://x.example');
  assert.equal(unquoteValue("'https://x.example'"), 'https://x.example');
  assert.equal(unquoteValue('https://x.example'), 'https://x.example');
  assert.equal(unquoteValue('"https://x.example'), '"https://x.example', '單邊引號不成對，原樣保留');

  for (const quoted of ['"' + LEGACY_URL + '"', "'" + LEGACY_URL + "'"]) {
    const settings = resolveSettings({ LTJ_API_TOKEN: TOKEN, LTJ_API_URL: quoted });
    assert.equal(settings.apiUrl, OFFICIAL_API_URL, quoted + ' 應被認出是舊正式站');
    assert.equal(settings.project, OFFICIAL_DEFAULT_PROJECT);
  }
  const custom = resolveSettings({ LTJ_API_TOKEN: TOKEN, LTJ_API_URL: '"https://jira.internal.example"' });
  assert.equal(custom.apiUrl, 'https://jira.internal.example', '引號不該留在實際連線的網址裡');
});

test('applyDefaults 會把舊網址實際改寫進 env（launcher 的子行程只看得到環境變數）', function () {
  const env = { LTJ_API_TOKEN: TOKEN, LTJ_API_URL: LEGACY_URL };
  const settings = applyDefaults(env);
  assert.equal(env.LTJ_API_URL, OFFICIAL_API_URL, '只補 missing 會讓子行程照舊連到已退役的站台');
  assert.equal(env.LTJ_PROJECT, OFFICIAL_DEFAULT_PROJECT);
  assert.equal(settings.migratedFromLegacy, true);

  // 自訂站台與明給的專案一個字都不動。
  const custom = { LTJ_API_TOKEN: TOKEN, LTJ_API_URL: OTHER_GAS_URL, LTJ_PROJECT: 'KEEP' };
  applyDefaults(custom);
  assert.equal(custom.LTJ_API_URL, OTHER_GAS_URL);
  assert.equal(custom.LTJ_PROJECT, 'KEEP');
});

test('MCP server / CLI 實際送出的請求都打新正式站', async function () {
  const cfg = getConfigFromEnv({ LTJ_API_TOKEN: TOKEN, LTJ_API_URL: LEGACY_URL });
  assert.equal(cfg.apiUrl, OFFICIAL_API_URL);
  assert.equal(cfg.project, OFFICIAL_DEFAULT_PROJECT);

  const urls = [];
  const fetchImpl = async function (url) {
    urls.push(String(url));
    return { status: 200, text: async function () { return JSON.stringify({ data: { items: [], nextCursor: null } }); } };
  };
  await callTool('litejira.searchTickets', { limit: 1 }, cfg, fetchImpl);
  assert.match(urls[0], new RegExp('^' + OFFICIAL_API_URL + '/'));
  assert.doesNotMatch(urls[0], /script\.google\.com/);
  assert.match(urls[0], /project=MAIN/);

  const cliUrls = [];
  const code = await runCli(
    ['search', '--limit', '1', '--json'],
    { LTJ_API_TOKEN: TOKEN, LTJ_API_URL: LEGACY_URL },
    { log: function () {}, error: function () {} },
    async function (url) {
      cliUrls.push(String(url));
      return { status: 200, text: async function () { return JSON.stringify({ data: { items: [], nextCursor: null } }); } };
    }
  );
  assert.equal(code, 0);
  assert.match(cliUrls[0], new RegExp('^' + OFFICIAL_API_URL + '/'));
});

test('setup：舊正式站憑證檔只有網址也能走完，並把新網址保存回去', async function () {
  const dir = tmpDir();
  const file = path.join(dir, 'credentials.env');
  fs.writeFileSync(file, '# 舊版安裝留下的設定\nLTJ_API_URL=' + LEGACY_URL + '\n');
  const out = collector();
  const err = collector();
  const seen = [];

  const code = await runSetup([], {
    env: {},
    dir: dir,
    // 這一檔測的是憑證檔的網址遷移；註冊 AI 主機設定另有專屬測試，這裡關掉以免碰到真實家目錄。
    register: false,
    home: dir,
    stdin: fakeStdin(TOKEN + '\r'),
    stdout: out,
    stderr: err,
    fetch: okFetch(seen)
  });

  assert.equal(code, 0, err.text());
  // 驗證打的是新正式站
  assert.equal(seen.length, 1);
  assert.match(seen[0], new RegExp('^' + OFFICIAL_API_URL + '/'));
  assert.match(seen[0], /project=MAIN/);
  // 遷移要說清楚
  assert.match(out.text(), /舊正式站/);
  assert.match(out.text(), new RegExp(OFFICIAL_API_URL));
  // 新網址要落地，未識別行原樣保留，token 不外洩
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, new RegExp('^LTJ_API_URL=' + OFFICIAL_API_URL.replace(/[.]/g, '\\.') + '$', 'm'));
  assert.doesNotMatch(text, /script\.google\.com/);
  assert.match(text, /^# 舊版安裝留下的設定$/m);
  assert.match(text, /^LTJ_API_TOKEN=/m);
  assert.equal(out.text().indexOf(TOKEN), -1);
});

test('setup：舊網址來自環境變數時也遷移，並提醒環境變數要一起更新', async function () {
  const dir = tmpDir();
  const out = collector();
  const seen = [];
  const code = await runSetup([], {
    env: { LTJ_API_URL: LEGACY_URL },
    dir: dir,
    // 這一檔測的是憑證檔的網址遷移；註冊 AI 主機設定另有專屬測試，這裡關掉以免碰到真實家目錄。
    register: false,
    home: dir,
    stdin: fakeStdin(TOKEN + '\r'),
    stdout: out,
    stderr: collector(),
    fetch: okFetch(seen)
  });

  assert.equal(code, 0);
  assert.match(seen[0], new RegExp('^' + OFFICIAL_API_URL + '/'));
  assert.match(out.text(), /環境變數 LTJ_API_URL/);
  const text = fs.readFileSync(path.join(dir, 'credentials.env'), 'utf8');
  assert.match(text, new RegExp('^LTJ_API_URL=' + OFFICIAL_API_URL.replace(/[.]/g, '\\.') + '$', 'm'));
});

test('setup：驗證失敗 / 取消時，舊網址的憑證檔一個字都不能動', async function () {
  const original = '# 舊版安裝留下的設定\nLTJ_API_URL=' + LEGACY_URL + '\nLTJ_API_TOKEN=old_token\n';

  const failDir = tmpDir();
  const failFile = path.join(failDir, 'credentials.env');
  fs.writeFileSync(failFile, original);
  const failErr = collector();
  const failCode = await runSetup([], {
    env: {},
    dir: failDir,
    home: failDir,
    register: false,
    stdin: fakeStdin('bad_token\r'),
    stdout: collector(),
    stderr: failErr,
    fetch: async function () {
      return { status: 401, text: async function () { return JSON.stringify({ error: { code: 'unauthorized', message: 'bad token' } }); } };
    }
  });
  assert.equal(failCode, 1);
  assert.equal(fs.readFileSync(failFile, 'utf8'), original, '驗證失敗不得順手把網址改掉');
  assert.match(failErr.text(), /未變更任何憑證/);

  const cancelDir = tmpDir();
  const cancelFile = path.join(cancelDir, 'credentials.env');
  fs.writeFileSync(cancelFile, original);
  const cancelCode = await runSetup([], {
    env: {},
    dir: cancelDir,
    home: cancelDir,
    register: false,
    stdin: fakeStdin('abc'),
    stdout: collector(),
    stderr: collector(),
    fetch: async function () { throw new Error('取消後不該驗證'); }
  });
  assert.equal(cancelCode, 130);
  assert.equal(fs.readFileSync(cancelFile, 'utf8'), original, '取消不得變更既有憑證');
});

test('setup：不認得的 GAS 站台講清楚是站台問題，不是叫人去補 LTJ_PROJECT', async function () {
  const dir = tmpDir();
  const err = collector();
  const code = await runSetup([], {
    env: { LTJ_API_URL: OTHER_GAS_URL },
    dir: dir,
    // 這一檔測的是憑證檔的網址遷移；註冊 AI 主機設定另有專屬測試，這裡關掉以免碰到真實家目錄。
    register: false,
    home: dir,
    stdin: fakeStdin(TOKEN + '\r'),
    stdout: collector(),
    stderr: err,
    fetch: async function () { throw new Error('不該驗證'); }
  });

  assert.equal(code, 2);
  assert.match(err.text(), /GAS|Apps Script/);
  assert.match(err.text(), new RegExp(OFFICIAL_API_URL), '要指出正式站網址，讓人可以自己改');
  assert.equal(fs.readdirSync(dir).length, 0, '不寫任何檔');
});

test('搜尋工具說明點出正式站預設專案 MAIN（避免把「只有 token」誤判成沒設定完）', function () {
  const { listTools } = require('../litejira-mcp-server');
  const search = listTools().find(function (t) { return t.name === 'litejira.searchTickets'; });
  assert.match(search.inputSchema.properties.project.description, /MAIN/);
});

test('自訂 GAS 已指定專案仍可驗證，網址與專案不被遷移', async function () {
  const dir = tmpDir();
  const seen = [];
  const code = await runSetup([], {
    env: { LTJ_API_URL: OTHER_GAS_URL, LTJ_PROJECT: 'CUSTOM' }, dir, register: false, home: dir,
    stdin: fakeStdin(TOKEN + '\r'), stdout: collector(), stderr: collector(), fetch: okFetch(seen)
  });
  assert.equal(code, 0);
  assert.ok(seen[0].startsWith(OTHER_GAS_URL));
  assert.match(seen[0], /project=CUSTOM/);
});

test('setup prod 優先更新既有 txt，環境網址優先於檔案且保留專案與唯讀', async function () {
  const dir = tmpDir();
  const file = path.join(dir, 'credentials.prod.txt');
  fs.writeFileSync(file, 'LTJ_API_URL=https://custom.example\nLTJ_PROJECT=OTHER\nLTJ_MCP_ENABLE_WRITES=false\n');
  const seen = [];
  const code = await runSetup(['prod'], {
    env: { LTJ_API_URL: LEGACY_URL }, dir, register: false, home: dir,
    stdin: fakeStdin(TOKEN + '\r'), stdout: collector(), stderr: collector(), fetch: okFetch(seen)
  });
  assert.equal(code, 0);
  assert.equal(new URL(seen[0]).origin, OFFICIAL_API_URL);
  assert.match(seen[0], /project=OTHER/);
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(saved.includes('LTJ_API_URL=' + OFFICIAL_API_URL));
  assert.match(saved, /LTJ_PROJECT=OTHER/);
  assert.match(saved, /LTJ_MCP_ENABLE_WRITES=false/);
  assert.equal(fs.existsSync(path.join(dir, 'credentials.env')), false);
});

test('真 launcher 子行程實際連新站 MAIN，prod 提示指向 setup prod', function () {
  const dir = tmpDir();
  const preload = path.join(dir, 'mock-fetch.cjs');
  const captured = path.join(dir, 'request.json');
  fs.writeFileSync(preload, `global.fetch = async (url) => {
    require('fs').writeFileSync(process.env.LTJ_TEST_REQUEST, JSON.stringify({url: String(url)}));
    return {status: 200, text: async () => JSON.stringify({data: {items: [], nextCursor: null}})};
  };`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('LTJ_') || key === 'NODE_OPTIONS') delete env[key];
  Object.assign(env, { HOME: dir, USERPROFILE: dir, LTJ_API_URL: LEGACY_URL,
    LTJ_API_TOKEN: TOKEN, LTJ_MCP_NO_UPDATE_CHECK: '1', LTJ_TEST_REQUEST: captured,
    NODE_OPTIONS: '--require ' + JSON.stringify(preload) });
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'litejira-mcp-launch.cjs'), 'prod'], {
    env, encoding: 'utf8', timeout: 15000,
    input: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'litejira.searchTickets', arguments: { limit: 1 }
    }}) + '\n'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /litejira-mcp setup prod/);
  const request = JSON.parse(fs.readFileSync(captured, 'utf8'));
  assert.equal(new URL(request.url).origin, OFFICIAL_API_URL);
  assert.equal(new URL(request.url).searchParams.get('project'), 'MAIN');
  const response = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(response[0].error, undefined);
});
