'use strict';

// GH-313：**真 stdio** 的唯讀 smoke。
//
// 與其他測試的差別：這一支不 require 伺服器模組，而是把 `litejira-mcp-server.js`
// 當成 MCP 主機會啟的那個行程 **spawn 起來**，用 stdin / stdout 跑 JSON-RPC。
// 它守的是「模組層測得過、實際啟動卻不通」這一類缺陷：啟動路徑、換行協定、
// 環境變數讀取、stdout 不被其他輸出污染。
//
// 憑證：**沒有**。伺服器指向本機 loopback 的 stub HTTP server（傳輸層允許 loopback http），
// 權杖是一個測試用字串。任何人 clone 下來都跑得起來，不需要正式站與正式 PAT。
//
// 範圍：唯讀。4 個讀取工具 + 6 個資源 + 4 個提示。
// 寫入不在本檔 —— 寫入的行為由既有的假 fetch 測試覆蓋（gh-257-pack3/pack4），
// 對真站的寫入驗收則是人工整合床的事，不由自動化測試代勞。

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'litejira-mcp-server.js');
const TOKEN = 'ltj_pat_smoke_not_a_real_token';
const PROJECT = 'SMOKE';
const UUID = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';

// stub 的回應一律是 v1 的 { data } 信封；內容只要夠讓客戶端拆信封即可，
// 不假裝是真資料（這支測的是通路，不是後端語意）。
function stubPayloadFor(pathname) {
  if (/\/tickets\/[^/]+\/comments$/.test(pathname)) return { items: [], nextCursor: null };
  if (/\/tickets\/[^/]+\/activity$/.test(pathname)) return { items: [], nextCursor: null };
  if (/\/tickets\/[^/]+\/transitions$/.test(pathname)) return { actions: [], transitions: [] };
  if (pathname.endsWith('/tickets')) return { items: [], nextCursor: null };
  if (/\/tickets\/[^/]+$/.test(pathname)) return { id: UUID, key: 'BUG-481', title: 'stub' };
  if (pathname.endsWith('/meta')) return { types: [], priorities: [], statuses: [] };
  if (pathname.endsWith('/members')) return { items: [] };
  if (pathname.endsWith('/versions')) return { items: [] };
  if (pathname.endsWith('/stats')) return { counts: {} };
  if (pathname.endsWith('/workflow')) return { rules: [] };
  return null;
}

function startStub() {
  const requests = [];
  const server = http.createServer(function (req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, pathname: url.pathname, search: url.search, auth: req.headers.authorization });
    const payload = stubPayloadFor(url.pathname);
    if (payload === null) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'stub 沒有這條路由：' + url.pathname } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: payload }));
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      resolve({ server: server, requests: requests, port: server.address().port });
    });
  });
}

// 一個 stdio 用戶端：逐行寫 JSON-RPC、逐行讀回應，用 id 對回來。
function startClient(baseUrl, extraEnv) {
  const child = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, {
      LTJ_API_URL: baseUrl,
      LTJ_API_TOKEN: TOKEN,
      LTJ_PROJECT: PROJECT,
      // 唯讀 smoke：寫入開關明確關掉，確保這支測試就算寫錯也打不出寫入請求。
      LTJ_MCP_ENABLE_WRITES: 'false'
    }, extraEnv || {}),
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const pending = new Map();
  const stderr = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', function (chunk) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === '') continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', function (chunk) { stderr.push(chunk); });

  let nextId = 0;
  return {
    stderr: stderr,
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

function okResult(response, label) {
  assert.strictEqual(response.error, undefined,
    label + ' 不該回 JSON-RPC error：' + JSON.stringify(response.error));
  assert.ok(response.result !== undefined, label + ' 沒有 result');
  return response.result;
}

test('GH-313 stdio smoke：唯讀通路（4 讀取工具 / 6 資源 / 4 提示）', async function (t) {
  const stub = await startStub();
  const baseUrl = 'http://127.0.0.1:' + stub.port;
  const client = startClient(baseUrl);
  t.after(function () {
    client.stop();
    stub.server.close();
  });

  // ── 握手 ──
  const init = okResult(await client.call('initialize', { protocolVersion: '2024-11-05' }), 'initialize');
  assert.strictEqual(init.serverInfo.name, 'litejira-mcp');
  assert.strictEqual(init.serverInfo.version, require('../package.json').version);
  assert.ok(init.capabilities.tools && init.capabilities.resources && init.capabilities.prompts);

  // ── 清單：18 工具 / 4 固定資源 + 2 模板 / 4 提示 ──
  const tools = okResult(await client.call('tools/list'), 'tools/list').tools;
  assert.strictEqual(tools.length, 18, '工具數：' + tools.map((x) => x.name).join(', '));

  const resources = okResult(await client.call('resources/list'), 'resources/list').resources;
  const templates = okResult(await client.call('resources/templates/list'), 'templates').resourceTemplates;
  assert.strictEqual(resources.length + templates.length, 6);

  const prompts = okResult(await client.call('prompts/list'), 'prompts/list').prompts;
  assert.strictEqual(prompts.length, 4);

  // ── 4 個讀取工具：每一支都真的打出一發 HTTP 請求 ──
  const readCalls = [
    ['litejira.searchTickets', { limit: 5 }, '/api/v1/tickets'],
    ['litejira.listComments', { ticketId: 'BUG-481', limit: 5 }, '/api/v1/tickets/BUG-481/comments'],
    ['litejira.getActivityLog', { ticketId: 'BUG-481', kind: 'system' }, '/api/v1/tickets/BUG-481/activity'],
    ['litejira.getTransitions', { ticketId: 'BUG-481' }, '/api/v1/tickets/BUG-481/transitions']
  ];
  for (const entry of readCalls) {
    const before = stub.requests.length;
    const result = okResult(
      await client.call('tools/call', { name: entry[0], arguments: entry[1] }), entry[0]);
    assert.ok(!result.isError, entry[0] + ' 回了 isError：' + JSON.stringify(result.content));
    assert.strictEqual(stub.requests.length, before + 1, entry[0] + ' 應該剛好打一發');
    const req = stub.requests[stub.requests.length - 1];
    assert.strictEqual(req.method, 'GET', entry[0] + ' 必須是 GET');
    assert.strictEqual(req.pathname, entry[2]);
    assert.strictEqual(req.auth, 'Bearer ' + TOKEN);
  }
  // searchTickets 沒帶 project 時要吃到 LTJ_PROJECT（GH-313 的專案必填）。
  const searchReq = stub.requests.find((r) => r.pathname === '/api/v1/tickets');
  assert.ok(searchReq.search.indexOf('project=' + PROJECT) !== -1, searchReq.search);

  // ── 6 個資源：4 個固定 URI + 2 個模板 ──
  const resourceCalls = [
    ['litejira://meta', '/api/v1/meta'],
    ['litejira://members?activeOnly=false', '/api/v1/members'],
    ['litejira://versions', '/api/v1/versions'],
    ['litejira://dashboard?scope=me', '/api/v1/stats'],
    ['litejira://workflow/BUG', '/api/v1/workflow'],
    ['litejira://ticket/BUG-481', '/api/v1/tickets/BUG-481']
  ];
  for (const entry of resourceCalls) {
    const before = stub.requests.length;
    const result = okResult(await client.call('resources/read', { uri: entry[0] }), entry[0]);
    assert.strictEqual(result.contents[0].uri, entry[0]);
    assert.strictEqual(result.contents[0].mimeType, 'application/json');
    JSON.parse(result.contents[0].text);   // 一定是可解析的 JSON（信封已拆一層）
    assert.strictEqual(stub.requests.length, before + 1, entry[0] + ' 應該剛好打一發');
    const req = stub.requests[stub.requests.length - 1];
    assert.strictEqual(req.method, 'GET');
    assert.strictEqual(req.pathname, entry[1]);
  }
  // 成員是工作區層級：不得夾帶 project（夾了就是打出一個不存在的查詢條件）。
  const membersReq = stub.requests.find((r) => r.pathname === '/api/v1/members');
  assert.ok(membersReq.search.indexOf('project=') === -1, membersReq.search);

  // ── 4 個提示：都取得到訊息，且只提到真的存在的工具名 ──
  const toolNames = tools.map((x) => x.name);
  const promptArgs = {
    'report-bug': { title: '登入閃退' },
    'weekly-status': {},
    'triage-ticket': { ticketId: 'BUG-481' },
    'close-ticket': { ticketId: 'BUG-481' }
  };
  for (const prompt of prompts) {
    const result = okResult(
      await client.call('prompts/get', { name: prompt.name, arguments: promptArgs[prompt.name] }),
      prompt.name);
    const text = result.messages.map((m) => m.content.text).join('\n');
    assert.ok(text.length > 0, prompt.name + ' 的提示是空的');
    const mentioned = text.match(/litejira\.[A-Za-z]+/g) || [];
    for (const name of mentioned) {
      assert.ok(toolNames.indexOf(name) !== -1, prompt.name + ' 提到不存在的工具：' + name);
    }
  }

  // ── 唯讀保證：整趟沒有任何非 GET 請求 ──
  const writes = stub.requests.filter((r) => r.method !== 'GET');
  assert.deepStrictEqual(writes, [], '唯讀 smoke 不該出現寫入請求');
});

test('GH-313：發版用的唯讀 smoke 腳本本身跑得起來（指向 stub，退出碼 0）', async function (t) {
  // scripts/smoke-stdio-readonly.cjs 是發版前對「真伺服器」跑的那一支。
  // 它自己也得是活的 —— 一支發版當天才發現壞掉的檢查腳本等於沒有檢查。
  // 這裡讓它打本機 stub：驗的是腳本的控制流與退出碼，不是後端語意。
  const stub = await startStub();
  t.after(function () { stub.server.close(); });

  const script = path.join(__dirname, '..', 'scripts', 'smoke-stdio-readonly.cjs');
  const child = spawn(process.execPath, [script], {
    env: Object.assign({}, process.env, {
      LTJ_API_URL: 'http://127.0.0.1:' + stub.port,
      LTJ_API_TOKEN: 'ltj_pat_smoke_not_a_real_token',
      LTJ_PROJECT: PROJECT,
      LTJ_SMOKE_TICKET: 'BUG-481',
      // 腳本必須自己把寫入關掉；這裡故意設成 true，證明它不吃外面的設定。
      LTJ_MCP_ENABLE_WRITES: 'true'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', function (chunk) { out += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', function (chunk) { out += chunk; });

  const code = await new Promise(function (resolve) { child.on('close', resolve); });
  assert.strictEqual(code, 0, 'smoke 腳本應回 0：\n' + out);
  assert.ok(out.indexOf('✖') === -1, '不該有失敗項：\n' + out);
  // 權杖不得出現在輸出裡。
  assert.ok(out.indexOf('ltj_pat_smoke_not_a_real_token') === -1, '輸出夾帶了權杖：\n' + out);
  // 唯讀：整趟沒有非 GET 請求（含腳本最後那一發 WRITES_DISABLED 檢查）。
  assert.deepStrictEqual(stub.requests.filter((r) => r.method !== 'GET'), []);
});

test('GH-313 stdio smoke：寫入開關關閉時，寫入工具在本機被擋下（不送出）', async function (t) {
  const stub = await startStub();
  const client = startClient('http://127.0.0.1:' + stub.port);
  t.after(function () {
    client.stop();
    stub.server.close();
  });

  await client.call('initialize', { protocolVersion: '2024-11-05' });
  const response = await client.call('tools/call', {
    name: 'litejira.addComment',
    arguments: { ticketId: 'BUG-481', body: '不該送出', idempotencyKey: 'smokeneverwritten01' }
  });
  assert.ok(response.error, '寫入應該回 JSON-RPC error');
  assert.strictEqual(response.error.data.code, 'WRITES_DISABLED');
  assert.deepStrictEqual(stub.requests, [], '一發都不該送出');
});
