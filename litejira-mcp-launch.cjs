#!/usr/bin/env node
// MCP server launcher: load credentials from ~/.litejira/, then spawn
// litejira-mcp-server.js with inherited stdio so Claude Code talks to the
// real server directly.
//
// Keeps secrets out of .mcp.json (which is checked into git).
//
// 選用參數 <env>（LJ-160 #1 路 B）：
//   litejira-mcp          → 讀 ~/.litejira/credentials.env（預設，一般使用者）
//   litejira-mcp dev      → 讀 ~/.litejira/credentials.dev.{txt,env}
//   litejira-mcp prod     → 讀 ~/.litejira/credentials.prod.{txt,env}
// 無參數時行為與舊版完全一致 → 向下相容，同事無感。

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');

// LJ-160 #3：啟動時檢查 npm 上有無新版，有就提醒（寫 stderr，絕不碰 stdout —
// stdout 是 MCP 協定通道）。非阻塞、離線/逾時一律靜默；可用 LTJ_MCP_NO_UPDATE_CHECK=1 關閉。
function checkForUpdate() {
  // 整段包 try/catch：更新檢查再怎麼壞都不可以弄垮啟動器（MCP 主職）。
  try {
    if (process.env.LTJ_MCP_NO_UPDATE_CHECK === '1') return;
    const current = require('./package.json').version;

    const req = https.get('https://registry.npmjs.org/litejira-mcp/latest', { timeout: 2500 }, res => {
      if (res.statusCode !== 200) { res.resume(); return; }
      let body = '';
      res.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
      res.on('end', () => {
        try {
          const latest = JSON.parse(body).version;
          if (latest && isNewer(latest, current)) {
            process.stderr.write(
              `\n⚠️  litejira-mcp 有新版 ${latest}（你目前 ${current}）。` +
              `更新：npm update -g litejira-mcp 後重啟 AI 工具。\n`
            );
          }
        } catch (_) { /* 靜默 */ }
      });
    });
    req.on('error', () => {});                     // 離線等錯誤一律靜默
    req.on('timeout', () => req.destroy());
    req.on('socket', s => { if (s && s.unref) s.unref(); }); // unref socket，不拖住行程結束
  } catch (_) { /* 靜默 */ }
}

// 純數字逐段比較 a 是否比 b 新（a > b）
function isNewer(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// 依參數挑 credentials 檔。dev/prod 各自找 .txt → .env；無參數沿用 credentials.env → .txt。
function resolveCredFile() {
  const target = (process.argv[2] || '').toLowerCase();
  const dir = path.join(os.homedir(), '.litejira');
  const names = (target === 'dev' || target === 'prod')
    ? [`credentials.${target}.txt`, `credentials.${target}.env`]
    : ['credentials.env', 'credentials.txt'];
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// `litejira-mcp setup [prod|dev]`：互動式設定 token，不啟動 MCP server。
// 放在讀憑證之前分流，因為 setup 自己要決定要更新哪個檔。
const SUB = (process.argv[2] || '').toLowerCase();
if (SUB === 'setup') {
  require('./litejira-setup')
    .runSetup(process.argv.slice(3))
    .then((code) => { process.exit(code); })
    .catch((err) => {
      process.stderr.write('setup 失敗：' + (err && err.message ? err.message : String(err)) + '\n');
      process.exit(1);
    });
  return;
}
if (SUB === 'help' || SUB === '--help' || SUB === '-h') {
  process.stdout.write(
    '用法：\n' +
    '  litejira-mcp setup [prod|dev]   互動式輸入並驗證 PAT，寫入 ~/.litejira/\n' +
    '  litejira-mcp [prod|dev]         啟動 MCP server（由 AI 工具呼叫，走 stdio）\n'
  );
  process.exit(0);
}

const credFile = resolveCredFile();
const envHasToken = !!(process.env.LTJ_API_TOKEN || process.env.LTJ_API_PAT);
if (credFile) {
  const text = fs.readFileSync(credFile, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    // GH-257：白名單新增 LTJ_PROJECT（非祕密，只是專案層級資源的預設專案 key）。
    // GH-317：新增 LTJ_MCP_MAX_UPLOAD_BYTES（非祕密，附件上傳的位元組上限）。
    // 白名單之外的行一律忽略，避免 credentials 檔意外注入任意環境變數。
    const m = line.match(
      /^(LTJ_API_URL|LTJ_API_TOKEN|LTJ_API_PAT|LTJ_MCP_ENABLE_WRITES|LTJ_PROJECT|LTJ_MCP_MAX_UPLOAD_BYTES)=(.+)$/);
    if (m && !(envHasToken && (m[1] === 'LTJ_API_TOKEN' || m[1] === 'LTJ_API_PAT')) && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// 憑證檔讀完後補上內建預設（正式站 + 主專案 MAIN），讓「只有 token」也能直接用。
// 只補沒有的鍵，所以檔案 / 環境變數裡的既有設定一律優先。
const settings = require('./litejira-config').applyDefaults(process.env);
if (settings.enableWritesInvalid) {
  process.stderr.write(
    '⚠️  LTJ_MCP_ENABLE_WRITES=「' + settings.enableWritesRaw + '」不是 true/false，' +
    '本次以唯讀模式啟動（fail closed）。\n'
  );
}

const serverPath = path.join(__dirname, 'litejira-mcp-server.js');
const child = spawn(process.execPath, [serverPath], {
  stdio: 'inherit',
  env: process.env
});

checkForUpdate(); // 非阻塞，與 server 啟動並行
child.on('exit', (code, signal) => {
  process.exit(typeof code === 'number' ? code : (signal ? 1 : 0));
});
