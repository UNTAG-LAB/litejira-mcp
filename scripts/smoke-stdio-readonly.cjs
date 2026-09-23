#!/usr/bin/env node
'use strict';

// LiteJira MCP —— 對「真的一台伺服器」跑的唯讀 stdio smoke（發版前檢查用）。
//
// 與 test/gh-313-stdio-smoke.test.js 的差別只有一個：那支打本機 stub、任何人都跑得起來；
// 這支打**你自己設定的那台**，用來在發版前確認「這個版本對這台伺服器真的通」。
//
// 憑證：**本檔不含也不寫入任何憑證**，一律從環境變數讀，並且不印出來。
//   LTJ_API_URL    必填，例：https://litejira.untaglab.com
//   LTJ_API_TOKEN  必填，你自己的 PAT
//   LTJ_PROJECT    必填（本腳本要求明給，不猜專案）
//   LTJ_SMOKE_TICKET  選填，一張你看得到的工單參照（UUID / BUG-481 / 數字）。
//                     沒給就用搜尋結果的第一張；搜不到就略過需要工單的那幾項。
//
// 唯讀保證：子行程一律以 LTJ_MCP_ENABLE_WRITES=false 啟動，本腳本也只呼叫讀取工具與資源。
//
// 用法：
//   node scripts/smoke-stdio-readonly.cjs
// 退出碼：0 = 全過；1 = 有項目失敗（逐項印出）。

const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'litejira-mcp-server.js');
const TIMEOUT_MS = 30000;

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    console.error('缺少環境變數 ' + name + '（本腳本不猜、也不讀憑證檔）');
    process.exit(2);
  }
  return value.trim();
}

function startClient(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, env, { LTJ_MCP_ENABLE_WRITES: 'false' }),
    stdio: ['pipe', 'pipe', 'inherit']
  });
  const pending = new Map();
  let buffer = '';
  let nextId = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', function (chunk) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (err) {
        continue;
      }
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });
  return {
    call: function (method, params) {
      const id = ++nextId;
      return new Promise(function (resolve, reject) {
        const timer = setTimeout(function () {
          pending.delete(id);
          reject(new Error('stdio 逾時：' + method));
        }, TIMEOUT_MS);
        pending.set(id, function (message) { clearTimeout(timer); resolve(message); });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }) + '\n');
      });
    },
    stop: function () { child.kill(); }
  };
}

const results = [];
async function step(label, fn) {
  try {
    const note = await fn();
    results.push({ ok: true, label: label, note: note || '' });
    console.log('✔ ' + label + (note ? '  — ' + note : ''));
  } catch (err) {
    results.push({ ok: false, label: label, note: err.message });
    console.log('✖ ' + label + '  — ' + err.message);
  }
}

// JSON-RPC error 的 message 由伺服器產生，可能含專案 / 工單字樣，但不含權杖
//（傳輸層明確不轉述 body 與 fetch 的原始訊息）。這裡照原樣印出以便判讀。
function resultOf(response, label) {
  if (response.error) throw new Error(label + ' 回 error：' + response.error.message);
  if (response.result === undefined) throw new Error(label + ' 沒有 result');
  return response.result;
}

function toolData(result, label) {
  if (result.isError) {
    throw new Error(label + ' 回 isError：' + (result.content || []).map((c) => c.text).join(' '));
  }
  return result.structuredContent;
}

async function main() {
  const env = {
    LTJ_API_URL: requireEnv('LTJ_API_URL'),
    LTJ_API_TOKEN: requireEnv('LTJ_API_TOKEN'),
    LTJ_PROJECT: requireEnv('LTJ_PROJECT')
  };
  console.log('目標：' + env.LTJ_API_URL + '  專案：' + env.LTJ_PROJECT + '（唯讀；權杖不印出）\n');

  const client = startClient(env);
  let ticket = process.env.LTJ_SMOKE_TICKET;

  try {
    await step('initialize', async function () {
      const result = resultOf(await client.call('initialize', { protocolVersion: '2024-11-05' }), 'initialize');
      return result.serverInfo.name + ' ' + result.serverInfo.version;
    });

    let toolCount = 0;
    await step('tools/list = 20', async function () {
      const tools = resultOf(await client.call('tools/list'), 'tools/list').tools;
      toolCount = tools.length;
      if (tools.length !== 20) throw new Error('預期 20，實得 ' + tools.length);
      return '20 個工具';
    });
    await step('resources/list + templates = 6', async function () {
      const fixed = resultOf(await client.call('resources/list'), 'resources/list').resources;
      const templated = resultOf(await client.call('resources/templates/list'), 'templates').resourceTemplates;
      const total = fixed.length + templated.length;
      if (total !== 6) throw new Error('預期 6，實得 ' + total);
      return fixed.length + ' 固定 + ' + templated.length + ' 模板';
    });
    await step('prompts/list = 4', async function () {
      const prompts = resultOf(await client.call('prompts/list'), 'prompts/list').prompts;
      if (prompts.length !== 4) throw new Error('預期 4，實得 ' + prompts.length);
      return prompts.map((p) => p.name).join(', ');
    });

    // ── 6 個資源 ──
    for (const uri of ['litejira://meta', 'litejira://members', 'litejira://versions',
      'litejira://dashboard', 'litejira://workflow/BUG']) {
      await step('resources/read ' + uri, async function () {
        const result = resultOf(await client.call('resources/read', { uri: uri }), uri);
        const text = result.contents[0].text;
        JSON.parse(text);
        return text.length + ' bytes';
      });
    }

    // ── 讀取工具：searchTickets 先跑，順便取一張工單給後面幾項用 ──
    await step('tools/call litejira.searchTickets', async function () {
      const result = resultOf(await client.call('tools/call',
        { name: 'litejira.searchTickets', arguments: { limit: 5 } }), 'searchTickets');
      const data = toolData(result, 'searchTickets');
      const items = data.items || [];
      if (!ticket && items.length > 0) ticket = items[0].key || items[0].id;
      return items.length + ' 張（nextCursor=' + String(data.nextCursor) + '）';
    });

    // 新的篩選運算子（XNot / XContains / overdue）：只驗**伺服器收、本機不誤擋**。
    // 語意（「不是」有沒有含空值、逾期算不算對）證明不了——那要有已知資料的驗收案例，
    // 一支對任意專案跑的唯讀 smoke 沒有那個前提，所以這裡不假裝驗到了。
    await step('tools/call litejira.searchTickets（statusNot / titleContains / overdue）', async function () {
      const result = resultOf(await client.call('tools/call', {
        name: 'litejira.searchTickets',
        arguments: { limit: 5, statusNot: '不存在的狀態', titleContains: 'a', overdue: false }
      }), 'searchTickets 篩選運算子');
      const data = toolData(result, 'searchTickets 篩選運算子');
      return (data.items || []).length + ' 張（伺服器接受這三個條件）';
    });

    if (!ticket) {
      console.log('⏭ 沒有可用工單（搜尋結果為空且未設 LTJ_SMOKE_TICKET）：略過工單相關的 4 項');
    } else {
      await step('resources/read litejira://ticket/' + ticket, async function () {
        const uri = 'litejira://ticket/' + ticket;
        const result = resultOf(await client.call('resources/read', { uri: uri }), uri);
        return JSON.parse(result.contents[0].text).key || '(無 key)';
      });
      for (const entry of [
        ['litejira.listComments', { ticketId: ticket, limit: 5 }],
        ['litejira.getActivityLog', { ticketId: ticket, limit: 5 }],
        ['litejira.getTransitions', { ticketId: ticket }]
      ]) {
        await step('tools/call ' + entry[0], async function () {
          const result = resultOf(await client.call('tools/call',
            { name: entry[0], arguments: entry[1] }), entry[0]);
          const data = toolData(result, entry[0]);
          return Array.isArray(data.items) ? data.items.length + ' 筆'
            : Array.isArray(data.actions) ? data.actions.length + ' 個動作' : 'ok';
        });
      }
    }

    // ── 4 個提示（純本機組字，不打伺服器）──
    const promptArgs = {
      'report-bug': {}, 'weekly-status': {},
      'triage-ticket': { ticketId: ticket || 'BUG-1' },
      'close-ticket': { ticketId: ticket || 'BUG-1' }
    };
    for (const name of Object.keys(promptArgs)) {
      await step('prompts/get ' + name, async function () {
        const result = resultOf(await client.call('prompts/get',
          { name: name, arguments: promptArgs[name] }), name);
        return result.messages.length + ' 則訊息';
      });
    }

    // 唯讀保證的收尾：確認寫入真的被擋（不送出任何請求）。
    await step('寫入開關關閉時被本機擋下（WRITES_DISABLED）', async function () {
      const response = await client.call('tools/call', {
        name: 'litejira.addComment',
        arguments: { ticketId: ticket || 'BUG-1', body: 'smoke 不該送出', idempotencyKey: 'smokeneverwritten01' }
      });
      if (!response.error || response.error.data.code !== 'WRITES_DISABLED') {
        throw new Error('預期 WRITES_DISABLED，實得 ' + JSON.stringify(response.error || response.result));
      }
      return '已擋下';
    });

    void toolCount;
  } finally {
    client.stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 項通過');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(function (err) {
  console.error('smoke 中斷：' + err.message);
  process.exit(1);
});
