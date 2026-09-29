'use strict';

// Token-only 設定：只有一把 PAT 就能讀寫正式站主專案 MAIN，
// 但自訂站台不得被偷偷套上 MAIN，且既有設定永遠優先。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OFFICIAL_API_URL,
  OFFICIAL_DEFAULT_PROJECT,
  applyDefaults,
  isOfficialUrl,
  resolveEnableWrites,
  resolveSettings
} = require('../litejira-config');
const { callTool, getConfigFromEnv } = require('../litejira-mcp-server');

test('只有 token：站台補正式站、專案補 MAIN、寫入預設開啟', function () {
  const settings = resolveSettings({ LTJ_API_TOKEN: 'ltj_pat_x' });
  assert.equal(settings.apiUrl, OFFICIAL_API_URL);
  assert.equal(settings.apiUrlSource, 'default');
  assert.equal(settings.project, OFFICIAL_DEFAULT_PROJECT);
  assert.equal(settings.projectSource, 'default');
  assert.equal(settings.enableWrites, true);
  assert.equal(settings.enableWritesInvalid, false);

  const cfg = getConfigFromEnv({ LTJ_API_TOKEN: 'ltj_pat_x' });
  assert.equal(cfg.apiUrl, OFFICIAL_API_URL);
  assert.equal(cfg.project, OFFICIAL_DEFAULT_PROJECT);
  assert.equal(cfg.token, 'ltj_pat_x');
  assert.equal(cfg.enableWrites, true);
});

test('舊名 LTJ_API_PAT 仍然算數', function () {
  assert.equal(resolveSettings({ LTJ_API_PAT: 'legacy' }).token, 'legacy');
});

test('自訂站台不套用 MAIN 預設', function () {
  const settings = resolveSettings({
    LTJ_API_TOKEN: 't',
    LTJ_API_URL: 'https://jira.internal.example'
  });
  assert.equal(settings.apiUrl, 'https://jira.internal.example');
  assert.equal(settings.project, '', '自訂站台不知道有哪些專案，補 MAIN 會誤投工單');
  assert.equal(settings.projectSource, 'none');
  assert.equal(getConfigFromEnv({ LTJ_API_TOKEN: 't', LTJ_API_URL: 'https://jira.internal.example' }).project, '');
});

test('正式站的 URL 寫法差異（結尾斜線 / 大小寫）仍算正式站', function () {
  assert.equal(isOfficialUrl('https://LiteJira.UNTAGLAB.com/'), true);
  assert.equal(isOfficialUrl('http://litejira.untaglab.com'), false, 'http 不是正式站');
  assert.equal(isOfficialUrl('https://litejira.untaglab.com.evil.test'), false);
  assert.equal(isOfficialUrl('not a url'), false);
  assert.equal(
    resolveSettings({ LTJ_API_TOKEN: 't', LTJ_API_URL: 'https://litejira.untaglab.com/' }).project,
    OFFICIAL_DEFAULT_PROJECT
  );
});

test('既有環境設定優先於內建預設', function () {
  const settings = resolveSettings({
    LTJ_API_TOKEN: 't',
    LTJ_API_URL: 'https://litejira.untaglab.com',
    LTJ_PROJECT: 'OTHER'
  });
  assert.equal(settings.project, 'OTHER');
  assert.equal(settings.projectSource, 'env');
});

test('applyDefaults 只補缺的鍵，不動既有值', function () {
  const env = { LTJ_API_TOKEN: 't', LTJ_PROJECT: 'KEEP' };
  applyDefaults(env);
  assert.equal(env.LTJ_PROJECT, 'KEEP');
  assert.equal(env.LTJ_API_URL, OFFICIAL_API_URL);

  const custom = { LTJ_API_TOKEN: 't', LTJ_API_URL: 'https://x.example' };
  applyDefaults(custom);
  assert.equal(custom.LTJ_API_URL, 'https://x.example');
  assert.equal(custom.LTJ_PROJECT, undefined);
});

test('LTJ_MCP_ENABLE_WRITES：未設＝開、false＝唯讀、其他值 fail closed', function () {
  assert.deepEqual(resolveEnableWrites(undefined), { enableWrites: true, invalid: false, raw: '' });
  assert.deepEqual(resolveEnableWrites('  '), { enableWrites: true, invalid: false, raw: '' });
  assert.equal(resolveEnableWrites('TRUE').enableWrites, true);
  assert.equal(resolveEnableWrites('False').enableWrites, false);
  assert.equal(resolveEnableWrites('False').invalid, false);
  for (const bad of ['1', '0', 'yes', 'ture', 'on']) {
    const r = resolveEnableWrites(bad);
    assert.equal(r.enableWrites, false, bad + ' 不該被當成開啟');
    assert.equal(r.invalid, true, bad + ' 應標記為非法值');
  }
});

test('唯讀模式下寫入工具被擋，且不送出任何請求', async function () {
  const cfg = getConfigFromEnv({ LTJ_API_TOKEN: 't', LTJ_MCP_ENABLE_WRITES: 'false' });
  assert.equal(cfg.enableWrites, false);
  let calls = 0;
  const fetchImpl = async function () { calls += 1; throw new Error('不該送出'); };
  await assert.rejects(
    function () { return callTool('litejira.addComment', { ticketId: 'BUG-1', body: 'hi', idempotencyKey: 'k'.repeat(20) }, cfg, fetchImpl); },
    function (err) { return err.code === 'WRITES_DISABLED'; }
  );
  assert.equal(calls, 0);
});

test('非法的寫入開關：擋下寫入並點名那個值', async function () {
  const cfg = getConfigFromEnv({ LTJ_API_TOKEN: 't', LTJ_MCP_ENABLE_WRITES: 'ture' });
  assert.equal(cfg.enableWrites, false);
  let calls = 0;
  const fetchImpl = async function () { calls += 1; throw new Error('不該送出'); };
  await assert.rejects(
    function () { return callTool('litejira.addComment', { ticketId: 'BUG-1', body: 'hi', idempotencyKey: 'k'.repeat(20) }, cfg, fetchImpl); },
    function (err) {
      assert.equal(err.code, 'WRITES_DISABLED');
      assert.match(err.message, /ture/);
      return true;
    }
  );
  assert.equal(calls, 0);
});

test('缺 token 時明確指路到 setup，且不送出請求', async function () {
  const cfg = getConfigFromEnv({});
  let calls = 0;
  const fetchImpl = async function () { calls += 1; throw new Error('不該送出'); };
  await assert.rejects(
    function () { return callTool('litejira.searchTickets', { limit: 1 }, cfg, fetchImpl); },
    function (err) {
      assert.equal(err.code, 'CONFIG_ERROR');
      assert.match(err.message, /litejira-mcp setup/);
      return true;
    }
  );
  assert.equal(calls, 0);
});

test('跨專案 mine 查詢不會被偷偷套上預設專案', async function () {
  const cfg = getConfigFromEnv({ LTJ_API_TOKEN: 't' });
  assert.equal(cfg.project, OFFICIAL_DEFAULT_PROJECT);
  const urls = [];
  const fetchImpl = async function (url) {
    urls.push(String(url));
    return { status: 200, text: async function () { return JSON.stringify({ data: { items: [], nextCursor: null } }); } };
  };
  await callTool('litejira.searchTickets', { mine: 'assignee' }, cfg, fetchImpl);
  assert.equal(urls.length, 1);
  assert.doesNotMatch(urls[0], /project=/, 'mine 是跨專案查詢，套預設專案會偷偷縮小範圍');
});

test('省略 project 的一般查詢會套用預設專案 MAIN', async function () {
  const cfg = getConfigFromEnv({ LTJ_API_TOKEN: 't' });
  const urls = [];
  const fetchImpl = async function (url) {
    urls.push(String(url));
    return { status: 200, text: async function () { return JSON.stringify({ data: { items: [], nextCursor: null } }); } };
  };
  await callTool('litejira.searchTickets', { limit: 5 }, cfg, fetchImpl);
  assert.match(urls[0], /project=MAIN/);
  assert.match(urls[0], new RegExp('^' + OFFICIAL_API_URL));
});
