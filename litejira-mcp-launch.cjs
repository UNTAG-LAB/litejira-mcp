#!/usr/bin/env node
// MCP server launcher: load credentials from ~/.litejira/credentials.env,
// then spawn litejira-mcp-server.js with inherited stdio so Claude Code
// talks to the real server directly.
//
// Keeps secrets out of .mcp.json (which is checked into git).

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

const credFile = path.join(os.homedir(), '.litejira', 'credentials.env');
if (fs.existsSync(credFile)) {
  const text = fs.readFileSync(credFile, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(LTJ_API_URL|LTJ_API_TOKEN|LTJ_API_PAT|LTJ_MCP_ENABLE_WRITES)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
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
